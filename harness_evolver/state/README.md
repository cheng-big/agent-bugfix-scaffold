# Evolution State

`evolution_state.json` and `bug_traces.jsonl` are the structured facts used by context injection. The scaffold ships a state generated from `../history/`; later project runs update it incrementally.

During an upgrade, preserve this directory. It is project-owned runtime knowledge once the scaffold has been installed.
