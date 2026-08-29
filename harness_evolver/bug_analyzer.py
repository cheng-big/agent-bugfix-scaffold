from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Iterable

from .llm_mapper import LLMMapper
from .models import BugTrace, RawBug, Stage, normalized_text, redact_sensitive_text


BUG_ID = re.compile(r"^(?:BUG|BUGFIX|B|U|E)-?\d+", re.IGNORECASE)
TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{3,}")


STAGE_KEYWORDS: dict[Stage, tuple[str, ...]] = {
    Stage.REQUIREMENT: (
        "需求", "业务", "状态机", "角色", "权限", "越权", "边界", "页面契约", "入口", "菜单",
        "详情", "字段", "中文", "tab", "布局", "交互", "认证状态", "监测点切换", "漏判", "缺失",
    ),
    Stage.DATABASE: (
        "数据库", "ddl", "sql", "索引", "外键", "字段长度", "bigint", "主键", "唯一键", "迁移",
        "flyway", "锁", "死锁", "审计字段", "软删除", "级联", "decimal", "快照表",
    ),
    Stage.CODING: (
        "代码", "组件", "空指针", "null", "异常", "事务", "幂等", "防重", "类型转换", "序列化",
        "sdk", "loader", "promise", "docker", "jar", "inode", "vite", "依赖", "编译", "h5", "vue",
        "spring", "java", "jwt", "缓存", "webgl", "key", "环境变量", "接口", "api",
    ),
    Stage.TESTING: (
        "测试", "mock", "探针", "验收", "覆盖", "边界值", "极值", "真机", "模拟器", "截图",
        "假绿", "证据", "回归", "浏览器", "联调数据", "多条真实", "设备", "构建后", "运行态",
    ),
}

STACK_KEYWORDS = {
    "Spring Boot": ("spring", "java", "mybatis", "jwt", "事务"),
    "MySQL/Flyway": ("mysql", "flyway", "ddl", "sql", "索引", "外键", "bigint"),
    "Vue/Element Plus": ("vue", "element", "pc", "管理后台", "tab", "抽屉"),
    "uni-app/WeChat": ("uni-app", "uniapp", "微信", "小程序", "h5", "dcloud"),
    "Docker": ("docker", "容器", "镜像", "jar", "inode"),
    "Third-party SDK": ("sdk", "腾讯地图", "高德", "webgl", "key", "api"),
}


@dataclass(slots=True)
class AnalysisResult:
    traces: list[BugTrace]
    mode: str
    warning: str = ""


def split_row(line: str) -> list[str]:
    body = line.strip().strip("|")
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in body:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def find_column(headers: list[str], names: tuple[str, ...]) -> int | None:
    for index, header in enumerate(headers):
        lowered = normalized_text(header)
        if any(name.lower() in lowered for name in names):
            return index
    return None


class BugAnalyzer:
    def __init__(self, use_llm: str = "never", batch_size: int = 20) -> None:
        if use_llm not in {"auto", "always", "never"}:
            raise ValueError("use_llm must be auto, always, or never")
        self.use_llm = use_llm
        self.batch_size = max(1, batch_size)
        self.llm = LLMMapper()
        if use_llm == "always" and not self.llm.configured:
            raise RuntimeError("--use-llm always requires HARNESS_EVOLVER_API_KEY and HARNESS_EVOLVER_MODEL")

    @property
    def analysis_profile(self) -> str:
        if self.use_llm == "never" or (self.use_llm == "auto" and not self.llm.configured):
            return "heuristic"
        return f"llm:{self.llm.profile}"

    def parse_document(self, path: str | Path, source_name: str | None = None) -> list[RawBug]:
        document = Path(path)
        lines = document.read_text(encoding="utf-8").splitlines()
        source = source_name or document.as_posix()
        bugs: list[RawBug] = []
        index = 0
        while index < len(lines) - 1:
            if not lines[index].lstrip().startswith("|") or not TABLE_SEPARATOR.match(lines[index + 1]):
                index += 1
                continue
            headers = split_row(lines[index])
            title_index = find_column(headers, ("用户反馈", "现象", "问题", "title", "bug"))
            cause_index = find_column(headers, ("根因", "定位结果", "cause"))
            resolution_index = find_column(headers, ("本轮处置", "修复", "解决", "corrective"))
            impact_index = find_column(headers, ("影响", "impact"))
            status_index = find_column(headers, ("状态", "status"))
            cursor = index + 2
            while cursor < len(lines) and lines[cursor].lstrip().startswith("|"):
                cells = split_row(lines[cursor])
                bug_id = cells[0].strip() if cells else ""
                if BUG_ID.match(bug_id) and not bug_id.upper().startswith("S-"):
                    def cell(position: int | None, fallback: int | None = None) -> str:
                        target = position if position is not None else fallback
                        return cells[target].strip() if target is not None and target < len(cells) else ""

                    bugs.append(
                        RawBug(
                            bug_id=bug_id.upper(),
                            title=redact_sensitive_text(cell(title_index, 1)),
                            root_cause=redact_sensitive_text(cell(cause_index, 2)),
                            resolution=redact_sensitive_text(cell(resolution_index)),
                            impact=redact_sensitive_text(cell(impact_index)),
                            status=cell(status_index),
                            source_doc=source,
                            source_line=cursor + 1,
                        )
                    )
                cursor += 1
            index = cursor

        if bugs:
            return bugs
        return self._parse_headings(lines, source)

    def _parse_headings(self, lines: list[str], source: str) -> list[RawBug]:
        bugs: list[RawBug] = []
        for index, line in enumerate(lines):
            match = re.match(r"^#{1,5}\s+((?:BUG|B|U|E)-?\d+)\s*[:：-]?\s*(.+)$", line, re.IGNORECASE)
            if not match:
                continue
            body = redact_sensitive_text(" ".join(value.strip() for value in lines[index + 1 : index + 7] if value.strip() and not value.startswith("#")))
            cause_match = re.search(r"(?:根因|原因|cause)[:：]\s*([^。；;]+)", body, re.IGNORECASE)
            fix_match = re.search(r"(?:修复|处置|solution)[:：]\s*([^。；;]+)", body, re.IGNORECASE)
            bugs.append(
                RawBug(
                    bug_id=match.group(1).upper(),
                    title=redact_sensitive_text(match.group(2).strip()),
                    root_cause=cause_match.group(1).strip() if cause_match else body[:240],
                    resolution=fix_match.group(1).strip() if fix_match else "",
                    source_doc=source,
                    source_line=index + 1,
                )
            )
        return bugs

    def analyze(self, bugs: Iterable[RawBug]) -> AnalysisResult:
        raw = list(bugs)
        wants_llm = self.use_llm == "always" or (self.use_llm == "auto" and self.llm.configured)
        if wants_llm:
            try:
                traces: list[BugTrace] = []
                for offset in range(0, len(raw), self.batch_size):
                    batch = raw[offset : offset + self.batch_size]
                    mapped = {item["bug_id"].upper(): item for item in self.llm.map_batch(batch)}
                    for bug in batch:
                        item = mapped.get(bug.bug_id)
                        traces.append(self._from_llm(bug, item) if item else self._heuristic(bug))
                return AnalysisResult(traces=traces, mode="llm")
            except Exception as exc:
                if self.use_llm == "always":
                    raise
                return AnalysisResult(
                    traces=[self._heuristic(bug) for bug in raw],
                    mode="heuristic-fallback",
                    warning=str(exc),
                )
        return AnalysisResult(traces=[self._heuristic(bug) for bug in raw], mode="heuristic")

    def _from_llm(self, bug: RawBug, item: dict | None) -> BugTrace:
        assert item is not None
        stage = Stage(item["stage_attribution"])
        stacks = item.get("tech_stack") or self._stacks(bug)
        if isinstance(stacks, str):
            stacks = [stacks]
        return BugTrace(
            bug_id=bug.bug_id,
            title=bug.title,
            stage_attribution=stage,
            failure_mode=str(item.get("failure_mode") or bug.root_cause or bug.title)[:280],
            corrective_guideline=str(item.get("corrective_guideline") or self._guideline(stage, bug))[:500],
            root_cause=bug.root_cause,
            resolution=bug.resolution,
            impact=bug.impact,
            source_doc=bug.source_doc,
            source_line=bug.source_line,
            confidence=max(0.0, min(float(item.get("confidence", 0.8)), 1.0)),
            tech_stack=sorted(set(stacks)),
            analysis_mode="llm",
        )

    def _heuristic(self, bug: RawBug) -> BugTrace:
        text = normalized_text(" ".join([bug.title, bug.root_cause, bug.resolution, bug.impact]))
        scores = {stage: 0 for stage in Stage}
        if bug.bug_id.startswith("U-"):
            scores[Stage.REQUIREMENT] += 1
        if bug.bug_id.startswith("E-"):
            scores[Stage.CODING] += 1
        for stage, keywords in STAGE_KEYWORDS.items():
            for keyword in keywords:
                if keyword.lower() in text:
                    scores[stage] += 2 if len(keyword) > 2 else 1
        if any(keyword in text for keyword in ("索引", "外键", "bigint", "字段长度", "flyway", "ddl")):
            scores[Stage.DATABASE] += 5
        if any(keyword in text for keyword in ("mock", "假绿", "真机", "模拟器", "验收证据", "测试覆盖")):
            scores[Stage.TESTING] += 5
        if any(keyword in text for keyword in ("agent context", "project.md", "evolver", "heuristic", "jaccard", "analyzer_version")):
            scores[Stage.CODING] += 8
        stage = max(Stage, key=lambda candidate: (scores[candidate], -list(Stage).index(candidate)))
        total = sum(scores.values()) or 1
        confidence = min(0.95, 0.55 + scores[stage] / total * 0.4)
        failure, guideline = self._pattern_guideline(stage, bug, text)
        return BugTrace(
            bug_id=bug.bug_id,
            title=bug.title,
            stage_attribution=stage,
            failure_mode=failure,
            corrective_guideline=guideline,
            root_cause=bug.root_cause,
            resolution=bug.resolution,
            impact=bug.impact,
            source_doc=bug.source_doc,
            source_line=bug.source_line,
            confidence=round(confidence, 3),
            tech_stack=self._stacks(bug),
            analysis_mode="heuristic",
        )

    def _stacks(self, bug: RawBug) -> list[str]:
        text = normalized_text(" ".join([bug.title, bug.root_cause, bug.resolution, bug.impact]))
        return [name for name, keywords in STACK_KEYWORDS.items() if any(keyword in text for keyword in keywords)]

    def _guideline(self, stage: Stage, bug: RawBug) -> str:
        text = normalized_text(" ".join([bug.title, bug.root_cause, bug.resolution, bug.impact]))
        return self._pattern_guideline(stage, bug, text)[1]

    def _pattern_guideline(self, stage: Stage, bug: RawBug, text: str) -> tuple[str, str]:
        if stage == Stage.REQUIREMENT:
            if any(token in text for token in ("中文", "字典", "枚举", "字段名", "camelcase", "显示值", "本地化")):
                return "页面信息架构与显示契约不完整", "页面契约必须覆盖列表到详情闭环、字段中文值与顺序、同级导航、重复入口、嵌套 Tab、空态/错误态和高频任务内联决策。"
            if any(token in text for token in ("认证", "微信", "openid", "绑定", "手机号核验")):
                return "身份与认证生命周期未完整建模", "需求与页面契约必须列出登录、认证、授权、绑定、解绑、停用和重新准入的完整状态矩阵，并逐状态定义路由、数据、动作与恢复。"
            if any(token in text for token in ("角色", "市级", "区县", "权限", "审核", "只读")):
                return "角色能力与禁止动作边界不完整", "需求拆分必须为每个角色生成菜单、允许动作、禁止动作和数据范围矩阵；只读角色在页面与接口两层都不得出现写入口。"
            if any(token in text for token in ("监测点", "父级", "多点", "切换", "上下文")):
                return "业务父级上下文与切换规则缺失", "页面契约必须声明业务父级上下文、可见位置、选择器、持久化、请求必带字段以及切换时未提交状态清理策略，并用至少两条真实数据验收。"
            if any(token in text for token in ("复盘", "账本", "脚手架", "反馈")):
                return "交付反馈未形成上游规则闭环", "交付阶段必须把用户反馈和工程失败结构化编号、归因并映射到上游阶段；阶段完成门禁检查新增反馈已进入 Evolver 事实账。"
            if any(token in text for token in ("地图", "供应商", "第三方", "key", "授权")):
                return "第三方能力契约与平台差异未定义", "需求与架构阶段必须定义第三方供应商、各平台能力、凭据与域名、授权主体、降级状态、生产责任人和真实接入证据。"
            if any(token in text for token in ("tab", "导航", "入口", "首页", "列表", "详情", "字段", "中文", "字典", "布局", "显示", "页面")):
                return "页面信息架构与显示契约不完整", "页面契约必须覆盖列表到详情闭环、字段中文值与顺序、同级导航、重复入口、嵌套 Tab、空态/错误态和高频任务内联决策。"
            return "业务流程或边界条件遗漏", "需求自审必须用反例遍历状态、角色、数据范围、异常、取消/重提和不可逆动作，并把每条边界转换为可验收断言。"

        if stage == Stage.DATABASE:
            if any(token in text for token in ("bigint", "2^53", "long", "id")):
                return "跨语言 ID 类型边界未约束", "数据模型与 API 契约必须统一大整数 ID 的序列化类型，并使用超过 JavaScript 安全整数的真实值验证列表到详情回读。"
            if any(token in text for token in ("索引", "慢查询")):
                return "访问模式缺少匹配索引", "DDL 生成必须从数据范围、状态、时间和关联查询反推复合索引，并输出最左前缀与查询计划验证。"
            if any(token in text for token in ("版本", "快照", "历史")):
                return "版本与只读快照模型不完整", "版本化实体必须定义业务键+版本唯一约束、当前版本指针、只读快照和同事务更新，禁止主档反改历史。"
            if any(token in text for token in ("并发", "锁", "幂等", "唯一")):
                return "并发唯一性与锁策略缺失", "DDL 与写模型必须联合定义唯一键、锁/重试、幂等键和唯一冲突转换，覆盖并发提交用例。"
            return "DDL 防御约束缺失", "DDL 生成前必须核对唯一性、复合索引、外键策略、字段容量、审计/软删除、版本快照、并发和迁移兼容性。"

        if stage == Stage.TESTING:
            if any(token in text for token in ("真机", "模拟器", "appid", "设备", "安全区", "软键盘")):
                return "原生设备与平台证据缺失", "测试矩阵必须在真实 AppID 的模拟器或真机覆盖原生组件、权限、软键盘、安全区和平台选择器；缺环境时显式标记证据边界。"
            if any(token in text for token in ("mock", "真实数据", "多条", "联调数据")):
                return "Mock 或单例数据掩盖真实流程", "关键流程必须使用至少两条真实关联数据、真实 API 和数据库回读，验证切换、范围与状态隔离，不得只靠 Mock 判绿。"
            return "验证层级或可见证据不足", "测试必须分离契约、构建、接口、数据库回读和可见浏览器证据，覆盖异常与边界分支，禁止用 200、编译或覆盖率单独判定完成。"

        if any(token in text for token in ("project.md", "agent context", "占位模板", "项目身份")):
            return "Harness 项目身份配置未完成", "Harness 安装与 doctor 必须拒绝未替换的项目身份占位符，并在 context 注入前验证角色、权限边界、真源和 DoD 已完成项目适配。"
        if any(token in text for token in ("evolver", "heuristic", "jaccard", "归因", "聚类", "analyzer_version")):
            return "反馈归因或规则聚类产生误合并", "Evolver 的算法与 Prompt 必须版本化；变更后强制重析，并用跨模式负样本验证只有同阶段且 guideline 相同或 failure mode 足够相似的规则才可合并。"
        if any(token in text for token in ("key", "secret", "凭据", "gitignore", ".env")):
            return "凭据隔离与跨平台产物边界失效", "编码与构建必须按平台隔离环境变量，默认忽略本地凭据，并在产物中用真实 Secret 做零命中扫描；日志和报告只输出计数。"
        if any(token in text for token in ("地图", "sdk", "loader", "promise", "webgl", "fitbounds", "抽屉", "画布")):
            return "第三方 SDK 生命周期与画布交互不健壮", "第三方 SDK 必须具备幂等加载、失败清缓存、可重试错误态、稳定容器尺寸与 resize；画布工具隔离点击命中并验证非空像素和覆盖物边距。"
        if any(token in text for token in ("docker", "jar", "inode", "镜像", "容器", "flyway")):
            return "构建产物与运行实例版本不一致", "启动与验收前必须核对实际运行产物哈希/时间、容器挂载 inode、迁移版本和接口标记；禁止用本地编译结果替代运行态证据。"
        if any(token in text for token in ("依赖", "sass", "vite", "peer", "编译", "构建")):
            return "构建依赖或多端编译契约不完整", "引入组件前必须检查其编译器、预处理器与 peer 依赖，并在实现完成后分别构建所有目标平台，保留上游依赖风险。"
        if any(token in text for token in ("bigint", "序列化", "json", "camelcase", "类型")):
            return "跨层类型与显示转换缺少统一边界", "公共序列化和显示适配层必须统一 ID、枚举、字典、日期与错误类型，页面不得直接遍历领域实体或原始快照。"
        if any(token in text for token in ("hmr", "日志", "缓存", "旧页面")):
            return "开发会话缓存被误当成最终运行态", "调试与验收必须建立新会话或时间边界，区分 HMR/控制台历史与当前构建，并回读实际产物和运行接口。"
        return "编码边界缺少防御性守卫", "编码阶段必须在输入校验、异常恢复、事务/幂等、权限范围、跨平台构建和第三方依赖边界提供显式守卫与可回读证据。"


def scan_markdown(inputs: Iterable[str | Path]) -> list[Path]:
    documents: set[Path] = set()
    for value in inputs:
        path = Path(value).expanduser().resolve()
        if path.is_file() and path.suffix.lower() == ".md":
            documents.add(path)
        elif path.is_dir():
            documents.update(candidate for candidate in path.rglob("*.md") if candidate.is_file())
    return sorted(documents)
