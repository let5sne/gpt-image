import fs from 'node:fs';
import path from 'node:path';

export const javaTypeBySpecType = {
  string: 'String',
  integer: 'Integer',
  enum: 'String',
};

export const sqlTypeBySpecType = {
  string: 'varchar(128)',
  integer: 'int',
  enum: 'varchar(32)',
};

const BUSINESS_ARTIFACT = 'ruoyi-business';

function upperFirst(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function toSnakeCase(value) {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`);
}

function javaString(value) {
  return JSON.stringify(String(value));
}

function javaComment(value) {
  return String(value).replaceAll('*/', '* /');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stableMenuBaseId(value) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash * 31) + char.charCodeAt(0)) % 7000;
  }
  return 20000 + (hash * 10);
}

function moduleContext(spec) {
  const className = spec.derived.className;
  const packageName = spec.derived.backendPackage;
  const packagePath = spec.derived.backendPackagePath;
  const resourceSegment = packageName.split('.').at(-1);

  return {
    className,
    variableName: spec.derived.variableName,
    packageName,
    packagePath,
    mapperNamespace: `${packageName}.mapper.${className}Mapper`,
    resourceSegment,
    sqlFileName: `ruoyi_business_${toSnakeCase(spec.module.name)}.sql`,
    fieldMethods: spec.fields.map((field) => ({
      ...field,
      javaType: javaTypeBySpecType[field.type],
      sqlType: sqlTypeBySpecType[field.type],
      columnName: toSnakeCase(field.name),
      accessorName: upperFirst(field.name),
    })),
  };
}

function createMinimalModulesPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.dromara</groupId>
  <artifactId>ruoyi-modules</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>ruoyi-business</module>
  </modules>
</project>`;
}

function createMinimalAdminPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.dromara</groupId>
  <artifactId>ruoyi-admin</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-business</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`;
}

function createBusinessPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.dromara</groupId>
    <artifactId>ruoyi-modules</artifactId>
    <version>${'${revision}'}</version>
  </parent>

  <artifactId>ruoyi-business</artifactId>
  <description>业务模块</description>

  <dependencies>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-doc</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-mybatis</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-log</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-excel</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-idempotent</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-common-satoken</artifactId>
    </dependency>
    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-system</artifactId>
    </dependency>
  </dependencies>
</project>`;
}

function injectModulePom(content) {
  if (content.includes('<module>ruoyi-business</module>')) {
    return content;
  }
  if (content.includes('</modules>')) {
    return content.replace('</modules>', '    <module>ruoyi-business</module>\n  </modules>');
  }
  return content.replace('</project>', '  <modules>\n    <module>ruoyi-business</module>\n  </modules>\n</project>');
}

function adminDependencyXml(includeVersion = false) {
  const versionLine = includeVersion ? '      <version>1.0.0</version>\n' : '';
  return `    <dependency>
      <groupId>org.dromara</groupId>
      <artifactId>ruoyi-business</artifactId>
${versionLine}    </dependency>`;
}

function injectAdminPom(content) {
  if (content.includes('<artifactId>ruoyi-business</artifactId>')) {
    return content;
  }
  if (content.includes('</dependencies>')) {
    return content.replace('</dependencies>', `${adminDependencyXml()}\n  </dependencies>`);
  }
  return content.replace('</project>', `  <dependencies>\n${adminDependencyXml()}\n  </dependencies>\n</project>`);
}

function upsertModulesPom(filePath) {
  if (!fs.existsSync(filePath)) {
    writeFile(filePath, createMinimalModulesPom());
    return;
  }
  fs.writeFileSync(filePath, injectModulePom(fs.readFileSync(filePath, 'utf8')));
}

function upsertAdminPom(filePath) {
  if (!fs.existsSync(filePath)) {
    writeFile(filePath, createMinimalAdminPom());
    return;
  }
  fs.writeFileSync(filePath, injectAdminPom(fs.readFileSync(filePath, 'utf8')));
}

function excelFieldDeclarations(context) {
  return context.fieldMethods.map((field) => `    /**
     * ${javaComment(field.title)}
     */
    @ExcelProperty(value = ${javaString(field.title)})
    private ${field.javaType} ${field.name};`).join('\n\n');
}

function domainFieldDeclarations(context) {
  return context.fieldMethods.map((field) => `    /**
     * ${javaComment(field.title)}
     */
    private ${field.javaType} ${field.name};`).join('\n\n');
}

function fieldResultMappings(context) {
  return context.fieldMethods.map((field) => `        <result property="${field.name}" column="${field.columnName}"/>`).join('\n');
}

function fieldColumns(context) {
  return context.fieldMethods.map((field) => field.columnName).join(', ');
}

function fieldXmlConditions(context, prefix) {
  return context.fieldMethods.map((field) => {
    if (field.type === 'string' || field.type === 'enum') {
      return `            <if test="${prefix}.${field.name} != null and ${prefix}.${field.name} != ''">and ${field.columnName} = #{${prefix}.${field.name}}</if>`;
    }
    return `            <if test="${prefix}.${field.name} != null">and ${field.columnName} = #{${prefix}.${field.name}}</if>`;
  }).join('\n');
}

function queryCondition(field, className) {
  const getter = `bo.get${field.accessorName}()`;
  if (field.type === 'string') {
    return `        lqw.like(StringUtils.isNotBlank(${getter}), ${className}::get${field.accessorName}, ${getter});`;
  }
  if (field.type === 'enum') {
    return `        lqw.eq(StringUtils.isNotBlank(${getter}), ${className}::get${field.accessorName}, ${getter});`;
  }
  return `        lqw.eq(${getter} != null, ${className}::get${field.accessorName}, ${getter});`;
}

function controllerTemplate(spec, context) {
  const { className, variableName, packageName } = context;
  return `package ${packageName}.controller;

import cn.dev33.satoken.annotation.SaCheckPermission;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.dromara.common.excel.utils.ExcelUtil;
import org.dromara.common.idempotent.annotation.RepeatSubmit;
import org.dromara.common.log.annotation.Log;
import org.dromara.common.log.enums.BusinessType;
import org.dromara.common.mybatis.core.page.PageQuery;
import org.dromara.common.mybatis.core.page.TableDataInfo;
import org.dromara.common.web.core.BaseController;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import ${packageName}.domain.bo.${className}Bo;
import ${packageName}.domain.vo.${className}Vo;
import ${packageName}.service.I${className}Service;

import java.util.Arrays;
import java.util.List;

/**
 * ${javaComment(spec.module.title)}
 */
@Validated
@RequiredArgsConstructor
@RestController
@RequestMapping(${javaString(spec.derived.apiBase)})
public class ${className}Controller extends BaseController {

    private final I${className}Service ${variableName}Service;

    @SaCheckPermission(${javaString(spec.permissions.list)})
    @GetMapping("/list")
    public TableDataInfo<${className}Vo> list(${className}Bo bo, PageQuery pageQuery) {
        return ${variableName}Service.queryPageList(bo, pageQuery);
    }

    @SaCheckPermission(${javaString(spec.permissions.export)})
    @Log(title = ${javaString(spec.module.title)}, businessType = BusinessType.EXPORT)
    @PostMapping("/export")
    public void export(${className}Bo bo, HttpServletResponse response) {
        List<${className}Vo> list = ${variableName}Service.queryList(bo);
        ExcelUtil.exportExcel(list, ${javaString(spec.module.title)}, ${className}Vo.class, response);
    }

    @SaCheckPermission(${javaString(spec.permissions.list)})
    @GetMapping("/{id}")
    public R<${className}Vo> getInfo(@NotNull(message = "主键不能为空") @PathVariable Long id) {
        return R.ok(${variableName}Service.queryById(id));
    }

    @SaCheckPermission(${javaString(spec.permissions.create)})
    @Log(title = ${javaString(spec.module.title)}, businessType = BusinessType.INSERT)
    @RepeatSubmit
    @PostMapping()
    public R<Void> add(@Validated @RequestBody ${className}Bo bo) {
        return toAjax(${variableName}Service.insertByBo(bo));
    }

    @SaCheckPermission(${javaString(spec.permissions.update)})
    @Log(title = ${javaString(spec.module.title)}, businessType = BusinessType.UPDATE)
    @RepeatSubmit
    @PutMapping()
    public R<Void> edit(@Validated @RequestBody ${className}Bo bo) {
        return toAjax(${variableName}Service.updateByBo(bo));
    }

    @SaCheckPermission(${javaString(spec.permissions.delete)})
    @Log(title = ${javaString(spec.module.title)}, businessType = BusinessType.DELETE)
    @DeleteMapping("/{ids}")
    public R<Void> remove(@NotEmpty(message = "主键不能为空") @PathVariable Long[] ids) {
        return toAjax(${variableName}Service.deleteWithValidByIds(Arrays.asList(ids), true));
    }
}`;
}

function domainTemplate(spec, context) {
  const { className, packageName } = context;
  return `package ${packageName}.domain;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;
import lombok.EqualsAndHashCode;
import org.dromara.common.mybatis.core.domain.BaseEntity;

/**
 * ${javaComment(spec.module.title)}
 */
@Data
@EqualsAndHashCode(callSuper = true)
@TableName(${javaString(spec.module.table)})
public class ${className} extends BaseEntity {

    @TableId(value = "id")
    private Long id;

${domainFieldDeclarations(context)}
}`;
}

function boTemplate(spec, context) {
  const { className, packageName } = context;
  return `package ${packageName}.domain.bo;

import io.github.linpeilie.annotations.AutoMapper;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;
import lombok.EqualsAndHashCode;
import org.dromara.common.mybatis.core.domain.BaseEntity;
import ${packageName}.domain.${className};

/**
 * ${javaComment(spec.module.title)}业务对象
 */
@Data
@EqualsAndHashCode(callSuper = true)
@AutoMapper(target = ${className}.class, reverseConvertGenerate = false)
public class ${className}Bo extends BaseEntity {

    private Long id;

${context.fieldMethods.map((field) => {
    const validation = field.required
      ? (field.type === 'integer'
        ? `    @NotNull(message = ${javaString(`${field.title}不能为空`)})\n`
        : `    @NotBlank(message = ${javaString(`${field.title}不能为空`)})\n`)
      : '';
    return `${validation}    private ${field.javaType} ${field.name};`;
  }).join('\n\n')}
}`;
}

function voTemplate(spec, context) {
  const { className, packageName } = context;
  return `package ${packageName}.domain.vo;

import com.alibaba.excel.annotation.ExcelProperty;
import io.github.linpeilie.annotations.AutoMapper;
import lombok.Data;
import ${packageName}.domain.${className};

/**
 * ${javaComment(spec.module.title)}视图对象
 */
@Data
@AutoMapper(target = ${className}.class)
public class ${className}Vo {

    private Long id;

${excelFieldDeclarations(context)}
}`;
}

function mapperTemplate(spec, context) {
  const { className, packageName } = context;
  return `package ${packageName}.mapper;

import org.dromara.common.mybatis.core.mapper.BaseMapperPlus;
import ${packageName}.domain.${className};
import ${packageName}.domain.vo.${className}Vo;

/**
 * ${javaComment(spec.module.title)}Mapper接口
 */
public interface ${className}Mapper extends BaseMapperPlus<${className}, ${className}Vo> {
}`;
}

function serviceTemplate(spec, context) {
  const { className, packageName } = context;
  return `package ${packageName}.service;

import org.dromara.common.mybatis.core.page.PageQuery;
import org.dromara.common.mybatis.core.page.TableDataInfo;
import ${packageName}.domain.bo.${className}Bo;
import ${packageName}.domain.vo.${className}Vo;

import java.util.Collection;
import java.util.List;

/**
 * ${javaComment(spec.module.title)}Service接口
 */
public interface I${className}Service {

    ${className}Vo queryById(Long id);

    TableDataInfo<${className}Vo> queryPageList(${className}Bo bo, PageQuery pageQuery);

    List<${className}Vo> queryList(${className}Bo bo);

    Boolean insertByBo(${className}Bo bo);

    Boolean updateByBo(${className}Bo bo);

    Boolean deleteWithValidByIds(Collection<Long> ids, Boolean isValid);
}`;
}

function serviceImplTemplate(spec, context) {
  const { className, variableName, packageName } = context;
  return `package ${packageName}.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.utils.MapstructUtils;
import org.dromara.common.core.utils.StringUtils;
import org.dromara.common.mybatis.core.page.PageQuery;
import org.dromara.common.mybatis.core.page.TableDataInfo;
import org.springframework.stereotype.Service;
import ${packageName}.domain.${className};
import ${packageName}.domain.bo.${className}Bo;
import ${packageName}.domain.vo.${className}Vo;
import ${packageName}.mapper.${className}Mapper;
import ${packageName}.service.I${className}Service;

import java.util.Collection;
import java.util.List;

/**
 * ${javaComment(spec.module.title)}Service业务层处理
 */
@RequiredArgsConstructor
@Service
public class ${className}ServiceImpl implements I${className}Service {

    private final ${className}Mapper baseMapper;

    @Override
    public ${className}Vo queryById(Long id) {
        return baseMapper.selectVoById(id);
    }

    @Override
    public TableDataInfo<${className}Vo> queryPageList(${className}Bo bo, PageQuery pageQuery) {
        LambdaQueryWrapper<${className}> lqw = buildQueryWrapper(bo);
        return baseMapper.selectPageVo(pageQuery.build(), lqw);
    }

    @Override
    public List<${className}Vo> queryList(${className}Bo bo) {
        LambdaQueryWrapper<${className}> lqw = buildQueryWrapper(bo);
        return baseMapper.selectVoList(lqw);
    }

    private LambdaQueryWrapper<${className}> buildQueryWrapper(${className}Bo bo) {
        LambdaQueryWrapper<${className}> lqw = Wrappers.lambdaQuery();
${context.fieldMethods.filter((field) => field.search).map((field) => queryCondition(field, className)).join('\n')}
        return lqw;
    }

    @Override
    public Boolean insertByBo(${className}Bo bo) {
        ${className} add = MapstructUtils.convert(bo, ${className}.class);
        validEntityBeforeSave(add);
        return baseMapper.insert(add) > 0;
    }

    @Override
    public Boolean updateByBo(${className}Bo bo) {
        ${className} update = MapstructUtils.convert(bo, ${className}.class);
        validEntityBeforeSave(update);
        return baseMapper.updateById(update) > 0;
    }

    private void validEntityBeforeSave(${className} entity) {
        // Reserve extension point for generated ${variableName} validation.
    }

    @Override
    public Boolean deleteWithValidByIds(Collection<Long> ids, Boolean isValid) {
        if (Boolean.TRUE.equals(isValid)) {
            // Reserve extension point for delete validation.
        }
        return baseMapper.deleteBatchIds(ids) > 0;
    }
}`;
}

function mapperXmlTemplate(spec, context) {
  const { className, mapperNamespace } = context;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper
PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
"http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="${mapperNamespace}">

    <resultMap type="${spec.derived.backendPackage}.domain.${className}" id="${className}Result">
        <id property="id" column="id"/>
${fieldResultMappings(context)}
    </resultMap>

    <sql id="select${className}Vo">
        select id, ${fieldColumns(context)}, create_dept, create_by, create_time, update_by, update_time
        from ${spec.module.table}
    </sql>

    <select id="select${className}List" resultMap="${className}Result">
        <include refid="select${className}Vo"/>
        <where>
${fieldXmlConditions(context, 'bo')}
        </where>
    </select>
</mapper>`;
}

function productPlanSqlTemplate() {
  return `create table if not exists biz_product_plan (
  id bigint not null comment '主键',
  plan_code varchar(128) not null comment '套餐编码',
  plan_name varchar(128) not null comment '套餐名称',
  price_cents int not null comment '售价分',
  credits int not null comment '点数',
  status varchar(32) not null default 'enabled' comment '状态',
  sort_order int not null default 0 comment '排序',
  create_dept bigint default null comment '创建部门',
  create_by bigint default null comment '创建者',
  create_time datetime default null comment '创建时间',
  update_by bigint default null comment '更新者',
  update_time datetime default null comment '更新时间',
  primary key (id),
  unique key uk_biz_product_plan_code (plan_code)
) engine=innodb comment='产品套餐';

insert into sys_menu values('19000', '业务管理', '0', '20', 'business', null, '', 1, 0, 'M', '0', '0', '', 'component', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19001', '产品套餐', '19000', '1', 'product-plan', 'business/product-plan/index', '', 1, 0, 'C', '0', '0', 'business:productPlan:list', 'money', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19002', '产品套餐查询', '19001', '1', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:list', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19003', '产品套餐新增', '19001', '2', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:add', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19004', '产品套餐修改', '19001', '3', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:edit', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19005', '产品套餐删除', '19001', '4', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:remove', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19006', '产品套餐导出', '19001', '5', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:export', '#', 103, 1, sysdate(), null, null, '');`;
}

function genericSqlTemplate(spec, context) {
  const fieldRows = context.fieldMethods.map((field) => {
    const defaultClause = Object.hasOwn(field, 'default')
      ? ` default ${field.type === 'integer' ? field.default : sqlString(field.default)}`
      : '';
    return `  ${field.columnName} ${field.sqlType} ${field.required ? `not null${defaultClause}` : `default null`} comment ${sqlString(field.title)},`;
  });
  const uniqueKeys = context.fieldMethods
    .filter((field) => field.unique)
    .map((field) => `  unique key uk_${spec.module.table}_${field.columnName} (${field.columnName})`);
  const keyRows = ['  primary key (id)', ...uniqueKeys].join(',\n');
  const baseId = stableMenuBaseId(spec.module.name);
  const [rootPath, ...childParts] = spec.module.menuPath.split('/');
  const routePath = childParts.at(-1) || rootPath;
  const componentPath = `${spec.module.menuPath}/index`;
  const parentTitle = rootPath === 'business' ? '业务管理' : rootPath;
  const menuRows = [
    `insert into sys_menu values('${baseId}', ${sqlString(parentTitle)}, '0', '20', ${sqlString(rootPath)}, null, '', 1, 0, 'M', '0', '0', '', 'component', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 1}', ${sqlString(spec.module.title)}, '${baseId}', '1', ${sqlString(routePath)}, ${sqlString(componentPath)}, '', 1, 0, 'C', '0', '0', ${sqlString(spec.permissions.list)}, 'list', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 2}', ${sqlString(`${spec.module.title}查询`)}, '${baseId + 1}', '1', '#', '', '', 1, 0, 'F', '0', '0', ${sqlString(spec.permissions.list)}, '#', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 3}', ${sqlString(`${spec.module.title}新增`)}, '${baseId + 1}', '2', '#', '', '', 1, 0, 'F', '0', '0', ${sqlString(spec.permissions.create)}, '#', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 4}', ${sqlString(`${spec.module.title}修改`)}, '${baseId + 1}', '3', '#', '', '', 1, 0, 'F', '0', '0', ${sqlString(spec.permissions.update)}, '#', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 5}', ${sqlString(`${spec.module.title}删除`)}, '${baseId + 1}', '4', '#', '', '', 1, 0, 'F', '0', '0', ${sqlString(spec.permissions.delete)}, '#', 103, 1, sysdate(), null, null, '');`,
    `insert into sys_menu values('${baseId + 6}', ${sqlString(`${spec.module.title}导出`)}, '${baseId + 1}', '5', '#', '', '', 1, 0, 'F', '0', '0', ${sqlString(spec.permissions.export)}, '#', 103, 1, sysdate(), null, null, '');`,
  ];

  return `create table if not exists ${spec.module.table} (
  id bigint not null comment '主键',
${fieldRows.join('\n')}
  create_dept bigint default null comment '创建部门',
  create_by bigint default null comment '创建者',
  create_time datetime default null comment '创建时间',
  update_by bigint default null comment '更新者',
  update_time datetime default null comment '更新时间',
${keyRows}
) engine=innodb comment=${sqlString(spec.module.title)};

${menuRows.join('\n')}`;
}

function sqlTemplate(spec, context) {
  if (spec.module.name === 'productPlan' && spec.module.table === 'biz_product_plan') {
    return productPlanSqlTemplate();
  }
  return genericSqlTemplate(spec, context);
}

export function getBackendGeneratedFiles(spec, backendRoot) {
  const context = moduleContext(spec);
  const sourceRoot = `ruoyi-modules/${BUSINESS_ARTIFACT}/src/main/java/${context.packagePath}`;
  const resourceRoot = `ruoyi-modules/${BUSINESS_ARTIFACT}/src/main/resources/mapper/${context.resourceSegment}`;
  const entries = [
    ['ruoyi-modules/pom.xml', null, true],
    ['ruoyi-admin/pom.xml', null, true],
    [`ruoyi-modules/${BUSINESS_ARTIFACT}/pom.xml`, createBusinessPom(), false],
    [`${sourceRoot}/controller/${context.className}Controller.java`, controllerTemplate(spec, context), false],
    [`${sourceRoot}/domain/${context.className}.java`, domainTemplate(spec, context), false],
    [`${sourceRoot}/domain/bo/${context.className}Bo.java`, boTemplate(spec, context), false],
    [`${sourceRoot}/domain/vo/${context.className}Vo.java`, voTemplate(spec, context), false],
    [`${sourceRoot}/mapper/${context.className}Mapper.java`, mapperTemplate(spec, context), false],
    [`${sourceRoot}/service/I${context.className}Service.java`, serviceTemplate(spec, context), false],
    [`${sourceRoot}/service/impl/${context.className}ServiceImpl.java`, serviceImplTemplate(spec, context), false],
    [`${resourceRoot}/${context.className}Mapper.xml`, mapperXmlTemplate(spec, context), false],
    [`script/sql/${context.sqlFileName}`, sqlTemplate(spec, context), false],
  ];

  return entries.map(([relativePath, content, pom]) => ({
    relativePath,
    filePath: path.resolve(backendRoot, relativePath),
    content,
    pom,
  }));
}

export function findBackendConflicts(spec, backendRoot) {
  return getBackendGeneratedFiles(spec, backendRoot)
    .filter((entry) => !entry.pom && fs.existsSync(entry.filePath))
    .map((entry) => entry.filePath);
}

export function writeBackendModule(spec, backendRoot) {
  const entries = getBackendGeneratedFiles(spec, backendRoot);

  for (const entry of entries) {
    if (entry.relativePath === 'ruoyi-modules/pom.xml') {
      upsertModulesPom(entry.filePath);
    } else if (entry.relativePath === 'ruoyi-admin/pom.xml') {
      upsertAdminPom(entry.filePath);
    } else {
      writeFile(entry.filePath, entry.content);
    }
  }

  return {
    ok: true,
    files: entries.map((entry) => entry.filePath),
  };
}

export function generateBackendModule(spec, backendRoot, options = {}) {
  const conflictFiles = findBackendConflicts(spec, backendRoot);

  if (conflictFiles.length > 0 && options.force !== true) {
    return {
      ok: false,
      code: 'generation_conflict',
      files: conflictFiles,
    };
  }

  return writeBackendModule(spec, backendRoot);
}
