# 嘉立创EDA 专业版 MCP 调用、多实例寻址与人机协同规范

1. **单位、真值网表与设计规则前置铁律**：
   - 高层工具统一采用公制 `mm` / `deg` 与国际标准电气单位；`jlc_api_invoke` 在 `unitMode="native"` 下使用嘉立创底层 `mil` 单位。
   - 严禁凭记忆编造芯片引脚编号或阻容参数：放置器件前必须经 `jlc_lib_device_inspect` 与 `jlc_datasheet_extract` 核实引脚、封装并提取原厂 `Layout Guidelines & Layout Example` 绑定至 CESM 模型；关键电气参数必须经 `jlc_elec_calc` 计算。
   - 电气连通性分析 100% 唯一采信 `eda.sch_Netlist` / `eda.pcb_Netlist` 编译态权威网表，严禁读取 `sch_PrimitiveWire` 二维坐标求交；PCB 布局与 DRC 校验严格遵循“芯片原厂 Datasheet `Layout Example` > 当前工程原生 `eda.pcb_Drc` 规则 > 内置物理经验矩阵”优先级，2.5D Keep-out 必须先求 `layerSet` 图层交集，严禁误报全层净空。
2. **客户端路径配置、一键启动与多实例自动寻址**：
   - 首次使用或找不到客户端时，先调用 `jlc_configure()` 自动扫描默认安装路径与注册表；若返回 `ERR_CLIENT_PATH_REQUIRED`（`status="NEED_USER_INPUT"`），再向用户询问安装目录或 `lceda-pro.exe` 路径后传入 `jlc_configure({ installDirOrExePath: "<路径>" })` 持久化保存。
   - 需要打开嘉立创EDA 专业版客户端时，直接调用 `jlc_launch()`（自动附加合规 CDP 调试参数，不强杀已有用户窗口）。
   - 连接已有窗口时先调用 `jlc_connect(launch=false)`。服务端联合扫描 `DevToolsActivePort`、Win32 前台窗口 Z-order 与 CDP `/json/list`，自动过滤 `devtools://` 与起始欢迎页，直连用户正在编辑的非空原理图或 PCB 标签页。
   - 多工程并开时，先查看 `jlc_connect` 返回的 `instances` 或 `jlc_documents`，再用 `jlc_connect(targetDocument="<名称>", editorType="pcb")` 或 `jlc_document_activate` 精准切换。
   - 确认无需保留残留空白欢迎页实例时，可传 `closeEmptyInstances=true` 优雅退出其他无打开工程的空进程。
3. **人机实时协同模式（与用户共用同一个打开的嘉立创EDA窗口）**：
   - 连接后检查 `jlc_documents` 的 `activeInteractiveTool`：若用户正在鼠标拖拽走线或悬空移动器件，等待空闲后再写入。
   - 用户说“选中了这颗芯片/这组电容/这段网络”时，**直接调用 `jlc_select(document="<doc>", readOnly=true)`** 只读获取图元句柄 `handle`、位号与公制坐标，**严禁清空用户选择集**。
   - PCB 布局前必须先调 `jlc_pcb_cluster_netlist` 按功能子电路分组排布，**严禁按位号把同类型电阻或电容集中排成一排**。
   - 经 `jlc_validate` 与 `jlc_view_capture` 双重核验通过后，按需原地保存；**交付阶段保持用户的工程标签页与客户端窗口处于打开状态**，且每次批量改动折叠为单步 Undo 供用户随时 `Ctrl+Z`。
4. **离线改图/批处理交付模式（MCP 自拉起客户端或从磁盘打开 `.epro` 修改交付）**：
   - 完成工程保存、制造文件（Gerber/BOM/CPL/PDF/STEP）导出并经 `jlc_validate` + `jlc_view_capture` 核验后，向用户交付前**必须**调用 `jlc_document_close(document="<handle>", releaseProcess=true)`。
   - 该操作释放 `.epro` 及本地库 SQLite/LevelDB 文件锁，并在该实例无其他打开工程时同步退出空闲 `lceda-pro.exe` 进程，确保用户可直接双击打开工程文件。
