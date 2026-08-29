# Bugfix 自动学习协议

- 每条用户消息先判断是否明确描述当前项目的具体 Bug。
- 命中 `问题/bug/报错/异常/失败/不对/不应该/打不开/不能/缺失/遗漏/不好用/需要修复` 时，在处理前执行 `node .agent/scripts/agent.mjs bug add --source user --title ".." --actual ".."`。
- “没有问题”、假设性讨论、引用文本、泛化 Bug 管理问题不得自动登记。
- 工程错误只有复现或有证据后执行 `node .agent/scripts/agent.mjs bug add --source engineering --title ".." --actual ".." --evidence ".."`。
- 用户说 `记入 Bug/记入复盘` 时立即登记当前具体问题。
- 用户说 `生成规则差异/项目复盘/进化脚手架` 时执行 `node .agent/scripts/agent.mjs bug evolve`。
- verify 通过且根因/影响/改动/对账/证据齐全后执行 `node .agent/scripts/agent.mjs bug close <id>`；不得凭关键词猜根因或归档。
- report 的 `complete` 会阻断未归档 Bug、复盘不一致、Evolver pending 和缺失报告。
- 自动触发仅在当前 Agent 会话内生效，不宣称后台监听会话外聊天。
