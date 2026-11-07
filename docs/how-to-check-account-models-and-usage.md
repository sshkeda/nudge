# How to Check Account, Models and Usage

For Claude Code, run `claude auth status` to see your account, `claude --help` to see the models and efforts, and `claude -p /usage` to see your usage and limits.

For Codex, run `codex login status` to see your account and `codex debug models` to see the models and efforts. To see your usage and limits, send `account/rateLimits/read` to Codex's app server:

```bash
{ printf '%s\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent","version":"0"}}}' '{"method":"initialized"}' '{"id":2,"method":"account/rateLimits/read"}'; sleep 5; } | codex app-server | grep -m1 '"id":2'
```
