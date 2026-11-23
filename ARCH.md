# Codex Chats List 架构

```mermaid
flowchart LR
  UI["VS Code 原生界面<br/>范围、分组和过滤"]
  Host["工作区扩展宿主<br/>同步和本地查询"]
  Git["工作区 Git"]
  Server["Codex app-server"]
  Codex["官方 Codex 侧栏"]
  Prefs["工作区状态<br/>范围和项目展开偏好"]
  Index["扩展全局存储<br/>共享会话索引"]
  UI <-->|"操作和节点更新"| Host
  Host <-->|"本地 stdio：thread/list"| Server
  Host <-->|"列表元数据和同步进度"| Index
  Git -->|"origin 和 upstream"| Host
  Host <-->|"保存视图偏好"| Prefs
  Host -->|"当前窗口 URI"| Codex
```

宿主从本地 app-server 首次逐页同步，再从共享索引按范围、目录或仓库加载树节点。同一存储范围下只有持有租约的窗口回源同步。点开会话时，宿主按 ID 校验该条元数据后跳转到官方侧栏。

查询与视图行为见 [DESIGN.md](DESIGN.md)，存储结构见 [history-schema.md](docs/history-schema.md)。
