import fs from 'node:fs';
import path from 'node:path';

function versionLine(label, version) {
  if (!version) {
    return `- ${label}: not recorded`;
  }

  const parts = [
    version.repo,
    version.tag ? `tag ${version.tag}` : undefined,
    version.ref ? `ref ${version.ref}` : undefined,
  ].filter(Boolean);

  return `- ${label}: ${parts.length > 0 ? parts.join(', ') : 'not recorded'}`;
}

function commandLine(command) {
  if (!command) {
    return '';
  }
  if (command.commandLine) {
    return command.commandLine;
  }
  return [command.command, ...(command.args || [])].filter(Boolean).join(' ');
}

function commandStatus(command) {
  if (!command) {
    return 'unknown';
  }
  if (command.statusText) {
    return command.statusText;
  }
  if (command.status === undefined || command.status === null) {
    return command.ok === false ? 'failed' : 'planned';
  }
  return command.status === 0 ? 'passed' : `failed (${command.status})`;
}

function markdownReport(payload) {
  const moduleInfo = payload.module || {};
  const versions = payload.versions || {};
  const commands = payload.commands || [];
  const generatedFiles = payload.generatedFiles || [];

  return `# RuoYi CRUD Agent Report

Status: ${payload.status || 'UNKNOWN'}

## Module

- Name: ${moduleInfo.name || 'unknown'}
- Title: ${moduleInfo.title || 'unknown'}

## Versions

${versionLine('RuoYi-Vue-Plus', versions.ruoyiVuePlus)}
${versionLine('Plus UI', versions.plusUi)}

## Commands

${commands.length > 0 ? commands.map((command) => `- ${commandLine(command)}: ${commandStatus(command)}`).join('\n') : '- No commands recorded'}

## Generated Files

${generatedFiles.length > 0 ? generatedFiles.map((file) => `- ${file}`).join('\n') : '- No generated files recorded'}
`;
}

export function writeReports(reportDir, payload) {
  fs.mkdirSync(reportDir, { recursive: true });

  const jsonPath = path.join(reportDir, 'ruoyi-crud-agent-report.json');
  const markdownPath = path.join(reportDir, 'ruoyi-crud-agent-report.md');

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdownReport(payload));

  return {
    ok: true,
    jsonPath,
    markdownPath,
  };
}
