// 流程层核心：方法论定义加载 + 运行时状态 + 阶段 task 惰性 seed + 产物磁盘回读 + 唯一下一步。
// 复用记忆底座（task/journal/statemachine），不重造轮子。产物真源=磁盘（existsSync）。

import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRoot, readJson, writeJsonAtomic, nowIso } from './store.mjs';
import { validate } from './schema.mjs';
import { newTask, taskExists, loadTask, writeTaskChecked } from './task.mjs';
import { findInterruptedSteps } from './journal.mjs';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'process', 'process.template.json');

export const processPath = () => join(agentRoot(), 'process.json');
export const statePath = () => join(agentRoot(), 'process-state.json');

// ---------- 定义 ----------
export function processExists() {
  return existsSync(processPath());
}

export function assertValidProcess(p) {
  const { valid, errors } = validate('process.schema.json', p);
  if (!valid) throw Object.assign(new Error('process.json 不符合 schema:\n  - ' + errors.join('\n  - ')), { code: 'ESCHEMA' });
}

export function loadProcess() {
  if (!processExists())
    throw Object.assign(new Error('未找到 .agent/process.json（先跑 `process init`）'), { code: 'ENOPROCESS' });
  const p = readJson(processPath());
  assertValidProcess(p);
  return p;
}

// 幂等：无则从模板生成 process.json。返回 { created }。
export function initProcessFile() {
  if (processExists()) return { created: false };
  if (!existsSync(TEMPLATE))
    throw Object.assign(new Error('缺 process/process.template.json，无法生成 process.json'), { code: 'ENOTEMPLATE' });
  copyFileSync(TEMPLATE, processPath());
  return { created: true };
}

// ---------- 运行时状态 ----------
export function freshState(p) {
  return {
    process_version: p.process_version,
    current_phase: null,
    phase_tasks: {},
    artifacts: [],
    updated_at: nowIso(),
  };
}

export function assertValidState(s) {
  const { valid, errors } = validate('process-state.schema.json', s);
  if (!valid) throw Object.assign(new Error('process-state.json 不符合 schema:\n  - ' + errors.join('\n  - ')), { code: 'ESCHEMA' });
}

export function loadState(p) {
  if (!existsSync(statePath())) return freshState(p || loadProcess());
  return readJson(statePath());
}

export function saveState(s) {
  s.updated_at = nowIso();
  assertValidState(s);
  writeJsonAtomic(statePath(), s);
  return s;
}

// ---------- 阶段 <-> task ----------
export function findPhase(p, phaseId) {
  return (p.phases || []).find((ph) => ph.id === phaseId);
}

export function phaseTaskId(state, phaseId) {
  return state.phase_tasks?.[phaseId] || null;
}

// 阶段 task 状态：not_started / planned / in_progress / verifying / blocked / completed / cancelled
export function phaseStatus(state, phaseId) {
  const id = phaseTaskId(state, phaseId);
  if (!id || !taskExists(id)) return 'not_started';
  return loadTask(id).status;
}

// 惰性建阶段 task 并登记进 state（设为当前阶段）。返回 { taskId, created }。
export function seedPhaseTask(p, phaseId, state) {
  const phase = findPhase(p, phaseId);
  if (!phase) throw Object.assign(new Error(`阶段不存在：${phaseId}`), { code: 'ENOPHASE' });
  let taskId = phaseTaskId(state, phaseId);
  let created = false;
  if (!taskId || !taskExists(taskId)) {
    taskId = `phase-${phaseId}`;
    if (!taskExists(taskId)) {
      const task = newTask({
        taskId,
        objective: `[${phase.no || ''} ${phase.name}] ${phase.intent || phase.name}`.trim(),
        phase: phase.name,
        nextAction: `${inputsHint(phase)}${firstArtifactHint(phase) || '产出本阶段产物'}`,
        dod: (phase.dod || []).map(String),
        constraints: (phase.gates || []).map(String),
        references: [...(phase.inputs || []).map((i) => `输入:${i.path}`), ...(phase.artifacts || []).map((a) => a.path)],
      });
      writeTaskChecked(task);
      created = true;
    }
    state.phase_tasks[phaseId] = taskId;
  }
  state.current_phase = phaseId;
  return { taskId, created };
}

function firstArtifactHint(phase) {
  const a = (phase.artifacts || []).find((x) => x.required !== false) || (phase.artifacts || [])[0];
  return a ? `产出「${a.name}」→ ${a.path}` : null;
}

// 输入真源提示：本阶段该读哪些输入（如阶段01 的需求文档）
export function inputsHint(phase) {
  const ins = phase.inputs || [];
  if (!ins.length) return '';
  return `先读真源：${ins.map((i) => `${i.name}(${i.path})`).join('、')}；`;
}

// ---------- 产物视图（磁盘回读）----------
export function registeredArtifact(state, phaseId, key) {
  return (state.artifacts || []).find((a) => a.phase_id === phaseId && a.key === key) || null;
}

// 某阶段每个期望产物的真实状态：{key,name,desc,required,target_path,registered,on_disk,status}
export function artifactViews(phase, state) {
  return (phase.artifacts || []).map((exp) => {
    const reg = registeredArtifact(state, phase.id, exp.key);
    const target = reg?.path || exp.path;
    const onDisk = !!(reg && existsSync(reg.path));
    return {
      key: exp.key,
      name: exp.name,
      desc: exp.desc || '',
      required: exp.required !== false,
      skills: exp.skills || phase.skills || [],
      target_path: target,
      registered: !!reg,
      on_disk: onDisk,
      status: reg?.status || null,
    };
  });
}

// 阶段顺序硬门：返回未满足的「直接前置阶段」列表（用于 phase start 拒绝跳阶段）。
// 前置阶段须 advanceable（task 已 completed 且 required 产物全部落盘）才算满足；
// 否则收集其状态/缺失产物。悬空依赖不拦（schema/P13 已保证 depends_on 不悬空）。
export function blockingDeps(p, state, phaseId) {
  const phase = findPhase(p, phaseId);
  if (!phase) return [];
  const out = [];
  for (const dep of phase.depends_on || []) {
    const depPhase = findPhase(p, dep);
    if (!depPhase) continue;
    const v = computePhaseView(depPhase, state);
    if (!v.advanceable) {
      out.push({ id: dep, name: depPhase.name, status: v.status, missing: v.requiredMissing.map((a) => a.name) });
    }
  }
  return out;
}

// 阶段视图：task 状态 + 产物视图 + 是否可推进（task 完成 且 required 产物全在磁盘）
export function computePhaseView(phase, state) {
  const status = phaseStatus(state, phase.id);
  const arts = artifactViews(phase, state);
  const requiredMissing = arts.filter((a) => a.required && !a.on_disk);
  const advanceable = status === 'completed' && requiredMissing.length === 0;
  return { phase, status, artifacts: arts, requiredMissing, advanceable };
}

// ---------- 开发任务清单（worklist：逐系统的标准开发任务）----------
// 取定义了 worklist 的阶段的模板（默认=逐系统建造阶段）。
export function worklistDef(p) {
  const ph = (p.phases || []).find((x) => (x.worklist || []).length);
  return ph ? ph.worklist : [];
}

// 登记一个业务系统：按 worklist 模板铺开全部任务（初始 not_started）。返回 { created, count }。
export function addSystem(p, state, key, name) {
  const wl = worklistDef(p);
  if (!wl.length) throw Object.assign(new Error('当前方法论未定义 worklist（开发任务模板）'), { code: 'ENOWORKLIST' });
  if (!state.systems) state.systems = [];
  if (state.systems.find((s) => s.key === key)) return { created: false, count: wl.length };
  state.systems.push({ key, name: name || key, tasks: wl.map((w) => ({ key: w.key, status: 'not_started' })) });
  return { created: true, count: wl.length };
}

// 更新某系统某开发任务的状态。返回该系统对象。
export function setWorklistStatus(p, state, sysKey, taskKey, status) {
  const wl = worklistDef(p);
  if (!wl.find((w) => w.key === taskKey))
    throw Object.assign(new Error(`任务 ${taskKey} 不在 worklist（合法：${wl.map((w) => w.key).join('/')}）`), { code: 'ENOTASK' });
  const sys = (state.systems || []).find((s) => s.key === sysKey);
  if (!sys) throw Object.assign(new Error(`未登记系统 ${sysKey}（先 system add）`), { code: 'ENOSYS' });
  let t = (sys.tasks || (sys.tasks = [])).find((x) => x.key === taskKey);
  if (!t) { t = { key: taskKey, status }; sys.tasks.push(t); } else t.status = status;
  t.updated_at = nowIso();
  return sys;
}

// ---------- 唯一下一步（纯计算，五条优先级）----------
// 返回 { done, phase_id, phase_name, action, skills, hint, target_path? }
export function computeNext(p, state) {
  const phases = p.phases || [];
  // 焦点阶段 = 第一个未完成的阶段（按数组顺序）
  const focus = phases.find((ph) => phaseStatus(state, ph.id) !== 'completed');

  // 5) 全部阶段完成
  if (!focus) {
    return { done: true, phase_id: null, phase_name: null, action: 'all-done', skills: [], hint: '全流程阶段已走完 —— 进入开发 / 持续迭代。' };
  }

  const skills = focus.skills || [];
  const status = phaseStatus(state, focus.id);

  // 未开始该阶段 → 先 phase start
  if (status === 'not_started') {
    const a = (focus.artifacts || []).find((x) => x.required !== false) || (focus.artifacts || [])[0];
    const how = skills.length ? `（用 ${skills.join(' / ')}）` : '';
    const src = inputsHint(focus);
    return {
      done: false, phase_id: focus.id, phase_name: focus.name, action: 'phase-start', skills,
      inputs: focus.inputs || [],
      hint: `${src}开始阶段「${focus.no || ''} ${focus.name}」→ 跑 \`phase start ${focus.id}\`${how}`.trim(),
      target_path: a?.path,
    };
  }

  // 1) 该阶段 task 有中断步骤 → 先恢复核对真实态
  const taskId = phaseTaskId(state, focus.id);
  const interrupted = taskId ? findInterruptedSteps(taskId) : [];
  if (interrupted.length) {
    return {
      done: false, phase_id: focus.id, phase_name: focus.name, action: 'recover', skills,
      hint: `阶段「${focus.name}」有 ${interrupted.length} 个中断步骤（${interrupted.map((s) => s.step_id).join(', ')}）→ 先核对真实态再 \`recover --reconcile <step> --evidence ..\` 或 \`--fail\`。`,
    };
  }

  // 阻塞 → 先解阻塞
  if (status === 'blocked') {
    return { done: false, phase_id: focus.id, phase_name: focus.name, action: 'unblock', skills, hint: `阶段「${focus.name}」处于 blocked —— 先解决 blocker 再继续。` };
  }

  // 1.5) 开发阶段 worklist：先按系统把标准开发任务推完
  const wl = focus.worklist || [];
  if (wl.length) {
    const systems = state.systems || [];
    if (!systems.length) {
      return {
        done: false, phase_id: focus.id, phase_name: focus.name, action: 'add-system', skills,
        hint: `阶段「${focus.name}」按系统建造 → 先登记要建的系统：\`system add <key> --name <名>\`（会自动铺开 ${wl.length} 个标准开发任务）。`,
      };
    }
    for (const s of systems) {
      const byKey = Object.fromEntries((s.tasks || []).map((t) => [t.key, t.status]));
      const pending = wl.find((w) => !['completed', 'cancelled'].includes(byKey[w.key] || 'not_started'));
      if (pending) {
        const how = skills.length ? `（用 ${skills.join(' / ')}）` : '';
        return {
          done: false, phase_id: focus.id, phase_name: focus.name, action: 'worklist-task', skills,
          hint: `系统「${s.name}」→ 做「${pending.name}」${how}，做到哪标到哪：\`worklist set --system ${s.key} --task ${pending.key} --status in_progress|completed\`。`,
        };
      }
    }
    // 全部系统全部任务完成 → 落到后续产物/DoD 收口
  }

  // 2) 有 required 产物未在磁盘 → 去产出它
  const arts = artifactViews(focus, state);
  const missing = arts.find((a) => a.required && !a.on_disk);
  if (missing) {
    const how = (missing.skills || []).length ? `用 ${missing.skills.join(' / ')} ` : '';
    const reg = missing.registered ? '（已登记但磁盘上没有，请核对/补产）' : '';
    const src = inputsHint(focus);
    return {
      done: false, phase_id: focus.id, phase_name: focus.name, action: 'produce-artifact', skills: missing.skills || skills,
      inputs: focus.inputs || [],
      hint: `${src}${how}产出「${missing.name}」→ ${missing.target_path}${reg}，产完 \`artifact add --phase ${focus.id} --key ${missing.key} --path <真实路径>\`。`,
      target_path: missing.target_path,
    };
  }

  // 3) 产物齐但阶段未完成 → 补 DoD 证据并 verify → complete
  return {
    done: false, phase_id: focus.id, phase_name: focus.name, action: 'complete-phase', skills,
    hint: `阶段「${focus.name}」required 产物已齐 → 补 DoD 证据、\`verify --evidence ..\`、\`dod set --index N --met --evidence ..\`，再 \`complete\`。`,
  };
}
