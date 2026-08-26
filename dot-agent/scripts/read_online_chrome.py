#!/usr/bin/env python3
# 可选录入器：从「已登录的 Chrome 标签页」抓在线文档（飞书 wiki / 腾讯文档 / Sheets 等）文本。
# 场景：bug 清单在需登录的在线文档、bug import 命令抓不到时，借你已登录的浏览器标签抓取，绕开鉴权。
# 用法：python3 read_online_chrome.py "<已打开标签的URL子串>"
#   例：python3 read_online_chrome.py "feishu.cn/wiki/AbCdEf"
# 依赖：macOS + Google Chrome（用 AppleScript 驱动，无第三方库）。
# 产出：打印去重文本行到 stdout —— 再把这些文本喂给 AI，归一化成 .agent/bugs.json（字段见 schemas/bug.schema.json）。
import subprocess, json, sys

url_key = sys.argv[1] if len(sys.argv) > 1 else ""
if not url_key:
    print('用法：python3 read_online_chrome.py "<已打开标签的URL子串>"', file=sys.stderr)
    sys.exit(2)

applescript = f'''
tell application "Google Chrome"
    repeat with w in windows
        repeat with t in tabs of w
            if URL of t contains "{url_key}" then
                set jsCmd to "(() => {{
                    let items = [];
                    document.querySelectorAll('div, span, td, th, p').forEach(el => {{
                        let t = (el.innerText || '').trim();
                        if (t && el.children.length === 0) {{ items.push(t); }}
                    }});
                    return JSON.stringify(Array.from(new Set(items)));
                }})()"
                return execute t javascript jsCmd
            end if
        end repeat
    end repeat
end tell
'''

res = subprocess.run(["osascript", "-e", applescript], capture_output=True, text=True)
if res.returncode == 0 and res.stdout.strip():
    try:
        data = json.loads(res.stdout.strip())
        print(f"从 Chrome 标签抓到 {len(data)} 条文本：")
        for item in data:
            print("- ", item)
    except Exception:
        print("Raw output:", res.stdout[:2000])
else:
    print("未找到匹配的 Chrome 标签 / 出错：", res.stderr, file=sys.stderr)
    sys.exit(1)
