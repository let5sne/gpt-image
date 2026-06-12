import fs from 'node:fs';
import path from 'node:path';

function tsTypeBySpecType(type) {
  return type === 'integer' ? 'number' : 'string';
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`);
}

function tsString(value) {
  return JSON.stringify(String(value));
}

function tsLiteral(value) {
  return typeof value === 'number' ? String(value) : tsString(value);
}

function htmlAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function singleQuotedDirective(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function moduleContext(spec) {
  return {
    className: spec.derived.className,
    variableName: spec.derived.variableName,
    apiBase: spec.derived.apiBase,
    apiDir: spec.derived.frontendApiDir,
    importApiDir: spec.derived.frontendApiDir.replace(/^src\//, ''),
    viewDir: spec.derived.frontendViewDir,
    fields: spec.fields,
    listFields: spec.fields.filter((field) => field.list),
    formFields: spec.fields.filter((field) => field.form),
    searchFields: spec.fields.filter((field) => field.search),
  };
}

function typesTemplate(spec, context) {
  const properties = context.fields.map((field) => `  ${field.name}?: ${tsTypeBySpecType(field.type)};`).join('\n');
  const queryProperties = context.searchFields.map((field) => `  ${field.name}?: ${tsTypeBySpecType(field.type)};`).join('\n');
  const formProperties = context.formFields.map((field) => `  ${field.name}?: ${tsTypeBySpecType(field.type)};`).join('\n');
  return `export interface ${context.className}VO {
  id: string | number;
${properties}
}

export interface ${context.className}Form {
  id?: string | number;
${formProperties}
}

export interface ${context.className}Query {
  pageNum?: number;
  pageSize?: number;
${queryProperties}
}`;
}

function apiTemplate(spec, context) {
  const className = context.className;
  const apiBase = context.apiBase;
  return `import request from '@/utils/request';
import { AxiosPromise } from 'axios';
import { ${className}VO, ${className}Form, ${className}Query } from '@/${context.importApiDir}/types';

export const list${className} = (query?: ${className}Query): AxiosPromise<${className}VO[]> => {
  return request({
    url: ${tsString(`${apiBase}/list`)},
    method: 'get',
    params: query
  });
};

export const get${className} = (id: string | number): AxiosPromise<${className}VO> => {
  return request({
    url: ${tsString(`${apiBase}/`)} + id,
    method: 'get'
  });
};

export const add${className} = (data: ${className}Form) => {
  return request({
    url: ${tsString(apiBase)},
    method: 'post',
    data
  });
};

export const update${className} = (data: ${className}Form) => {
  return request({
    url: ${tsString(apiBase)},
    method: 'put',
    data
  });
};

export const del${className} = (id: string | number | Array<string | number>) => {
  return request({
    url: ${tsString(`${apiBase}/`)} + id,
    method: 'delete'
  });
};`;
}

function defaultValue(field) {
  if (Object.hasOwn(field, 'default')) {
    return tsLiteral(field.default);
  }
  return 'undefined';
}

function inputComponent(field, model) {
  const title = htmlAttr(field.title);
  if (field.type === 'enum') {
    const options = field.options.map((option) => `            <el-option label="${htmlAttr(option)}" value="${htmlAttr(option)}" />`).join('\n');
    return `<el-select v-model="${model}.${field.name}" placeholder="请选择${title}" clearable>
${options}
          </el-select>`;
  }
  if (field.type === 'integer') {
    return `<el-input-number v-model="${model}.${field.name}" :min="${field.min ?? 0}" controls-position="right" />`;
  }
  return `<el-input v-model="${model}.${field.name}" placeholder="请输入${title}" clearable />`;
}

function searchItems(context) {
  return context.searchFields.map((field) => `      <el-form-item label="${htmlAttr(field.title)}" prop="${field.name}">
        ${inputComponent(field, 'queryParams').replaceAll('\n', '\n        ')}
      </el-form-item>`).join('\n');
}

function columns(context) {
  return context.listFields.map((field) => `      <el-table-column label="${htmlAttr(field.title)}" align="center" prop="${field.name}" />`).join('\n');
}

function formItems(context) {
  return context.formFields.map((field) => `        <el-form-item label="${htmlAttr(field.title)}" prop="${field.name}">
          ${inputComponent(field, 'form').replaceAll('\n', '\n          ')}
        </el-form-item>`).join('\n');
}

function formDefaults(context) {
  return context.formFields.map((field) => `  ${field.name}: ${defaultValue(field)}`).join(',\n');
}

function queryDefaults(context) {
  return context.searchFields.map((field) => `    ${field.name}: undefined`).join(',\n');
}

function validationRules(context) {
  return context.formFields
    .filter((field) => field.required)
    .map((field) => `    ${field.name}: [{ required: true, message: ${tsString(`${field.title}不能为空`)}, trigger: ${tsString(field.type === 'enum' ? 'change' : 'blur')} }]`)
    .join(',\n');
}

function vueTemplate(spec, context) {
  const className = context.className;
  const addPerm = singleQuotedDirective(spec.permissions.create);
  const editPerm = singleQuotedDirective(spec.permissions.update);
  const deletePerm = singleQuotedDirective(spec.permissions.delete);
  const exportPerm = singleQuotedDirective(spec.permissions.export);
  return `<template>
  <div class="p-2">
    <el-form ref="queryFormRef" :model="queryParams" :inline="true" label-width="80px">
${searchItems(context)}
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="[${addPerm}]">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="success" plain icon="Edit" :disabled="single" @click="handleUpdate()" v-hasPermi="[${editPerm}]">修改</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" plain icon="Delete" :disabled="multiple" @click="handleDelete()" v-hasPermi="[${deletePerm}]">删除</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="warning" plain icon="Download" @click="handleExport" v-hasPermi="[${exportPerm}]">导出</el-button>
      </el-col>
    </el-row>

    <el-table v-loading="loading" :data="${context.variableName}List" @selection-change="handleSelectionChange">
      <el-table-column type="selection" width="55" align="center" />
      <el-table-column label="主键" align="center" prop="id" />
${columns(context)}
      <el-table-column label="操作" align="center" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-tooltip content="修改" placement="top">
            <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="[${editPerm}]" />
          </el-tooltip>
          <el-tooltip content="删除" placement="top">
            <el-button link type="primary" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="[${deletePerm}]" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" :total="total" @pagination="getList" />

    <el-dialog v-model="open" :title="title" width="560px" append-to-body>
      <el-form ref="${context.variableName}FormRef" :model="form" :rules="rules" label-width="90px">
${formItems(context)}
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button :loading="buttonLoading" type="primary" @click="submitForm">确 定</el-button>
          <el-button @click="cancel">取 消</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { list${className}, get${className}, del${className}, add${className}, update${className} } from '@/${context.importApiDir}';
import { ${className}VO, ${className}Form, ${className}Query } from '@/${context.importApiDir}/types';

const { proxy } = getCurrentInstance() as ComponentInternalInstance;

const ${context.variableName}List = ref<${className}VO[]>([]);
const buttonLoading = ref(false);
const loading = ref(true);
const open = ref(false);
const ids = ref<Array<string | number>>([]);
const single = ref(true);
const multiple = ref(true);
const total = ref(0);
const title = ref('');

const queryFormRef = ref<ElFormInstance>();
const ${context.variableName}FormRef = ref<ElFormInstance>();

const initFormData: ${className}Form = {
${formDefaults(context)}
};

const data = reactive({
  form: { ...initFormData } as ${className}Form,
  queryParams: {
    pageNum: 1,
    pageSize: 10${context.searchFields.length > 0 ? ',\n' : ''}
${queryDefaults(context)}
  } as ${className}Query,
  rules: {
${validationRules(context)}
  }
});

const { queryParams, form, rules } = toRefs(data);

const getList = async () => {
  loading.value = true;
  const res = await list${className}(queryParams.value);
  ${context.variableName}List.value = res.rows || res.data || [];
  total.value = res.total || 0;
  loading.value = false;
};

const cancel = () => {
  open.value = false;
  reset();
};

const reset = () => {
  form.value = { ...initFormData };
  ${context.variableName}FormRef.value?.resetFields();
};

const handleQuery = () => {
  queryParams.value.pageNum = 1;
  getList();
};

const resetQuery = () => {
  queryFormRef.value?.resetFields();
  handleQuery();
};

const handleSelectionChange = (selection: ${className}VO[]) => {
  ids.value = selection.map((item) => item.id);
  single.value = selection.length !== 1;
  multiple.value = !selection.length;
};

const handleAdd = () => {
  reset();
  open.value = true;
  title.value = ${tsString(`添加${spec.module.title}`)};
};

const handleUpdate = async (row?: ${className}VO) => {
  reset();
  const id = row?.id || ids.value[0];
  const res = await get${className}(id);
  form.value = res.data;
  open.value = true;
  title.value = ${tsString(`修改${spec.module.title}`)};
};

const submitForm = () => {
  ${context.variableName}FormRef.value?.validate(async (valid: boolean) => {
    if (!valid) return;
    buttonLoading.value = true;
    if (form.value.id) {
      await update${className}(form.value);
    } else {
      await add${className}(form.value);
    }
    proxy?.$modal.msgSuccess('操作成功');
    open.value = false;
    await getList();
    buttonLoading.value = false;
  });
};

const handleDelete = async (row?: ${className}VO) => {
  const deleteIds = row?.id || ids.value;
  await proxy?.$modal.confirm(${tsString(`是否确认删除${spec.module.title}编号为"`)} + deleteIds + ${tsString('"的数据项？')});
  await del${className}(deleteIds);
  await getList();
  proxy?.$modal.msgSuccess('删除成功');
};

const handleExport = () => {
  proxy?.download(${tsString(`${context.apiBase}/export`)}, {
    ...queryParams.value
  }, \`${context.variableName}_\${new Date().getTime()}.xlsx\`);
};

onMounted(() => {
  getList();
});
</script>`;
}

export function getFrontendGeneratedFiles(spec, frontendRoot) {
  const context = moduleContext(spec);
  return [
    [`${context.apiDir}/types.ts`, typesTemplate(spec, context)],
    [`${context.apiDir}/index.ts`, apiTemplate(spec, context)],
    [`${context.viewDir}/index.vue`, vueTemplate(spec, context)],
  ].map(([relativePath, content]) => ({
    relativePath,
    filePath: path.resolve(frontendRoot, relativePath),
    content,
    pom: false,
  }));
}

export function findFrontendConflicts(spec, frontendRoot) {
  return getFrontendGeneratedFiles(spec, frontendRoot)
    .filter((entry) => fs.existsSync(entry.filePath))
    .map((entry) => entry.filePath);
}

export function writeFrontendModule(spec, frontendRoot) {
  const entries = getFrontendGeneratedFiles(spec, frontendRoot);
  for (const entry of entries) {
    writeFile(entry.filePath, entry.content);
  }
  return {
    ok: true,
    files: entries.map((entry) => entry.filePath),
  };
}

export function generateFrontendModule(spec, frontendRoot, options = {}) {
  const conflictFiles = findFrontendConflicts(spec, frontendRoot);

  if (conflictFiles.length > 0 && options.force !== true) {
    return {
      ok: false,
      code: 'generation_conflict',
      files: conflictFiles,
    };
  }

  return writeFrontendModule(spec, frontendRoot);
}
