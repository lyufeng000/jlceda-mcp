# 嘉立创EDA 专业版 MCP Server (`jlceda-mcp`)

面向**嘉立创EDA 专业版（EasyEDA Pro）**的零桥接 CDP 原生直连 + REA 无伪源码接口索引 + 五层确定性电气工程护栏 + 模块化预分组布局与四级自动布线闭环 MCP 服务端。

## 架构概览

1. **环境探测与路径后补 (`src/env/`)**：五级瀑布（L0~L4）自动定位桌面客户端路径、版本与 SHA-256 指纹；未安装或未登录态支持优雅降级。
2. **REA 无伪源码逆向底座 (`src/rea/`)**：内存读取 `app.asar`/`resources/app` `.d.ts` 与 AST 特征指纹，生成 `catalog/api_catalog.sqlite`（FTS5 BM25 `< 3 ms` 检索）及 `adapter_bindings.<sha256>.json`，严格保证 **0 字节反编译伪源码落盘**。
3. **零桥接 CDP 内核 (`src/cdp/`)**：原生 WebSocket 直连 Electron 渲染进程，跳过欢迎页智能寻址、双层看门狗防死锁、200 项分页游标与 Base64 持久引用、Undo 事务原子回滚及公制标尺 HUD 双图并排合成。
4. **五层确定性电气工程引擎 (`src/electrical/` + `src/linters/`)**：CESM 数据手册真值模型（含原厂 `Layout Example`）、9 大确定性计算器、9 大黄金子电路积木、无头 SPICE/MNA 仿真、28 条原理图电气审计（`ELINT-001~028`，100% 唯一采信 `eda.sch_Netlist`）。
5. **模块化布局与四级布线/审计 (`src/layout-routing/` + `src/linters/`)**：Leiden 网表预聚类、四阶段无碰撞布局、第 1~3 级关键布线/FreeRouting/防立碑铺铜缝合、18 条 2.5D 计算几何 Linter（`PLINT-01~18`）与四合一总门禁 `jlc_validate`。

## 6 层 41 个 MCP 工具清单

- **第 1 层（会话、文档、选择集与句柄管理，14 个）**：`jlc_connect`, `jlc_session_status`, `jlc_capabilities`, `jlc_documents`, `jlc_document_new`, `jlc_document_open`, `jlc_document_activate`, `jlc_document_save`, `jlc_document_close`, `jlc_select`, `jlc_reference_create`, `jlc_reference_resolve`, `jlc_array_read`, `jlc_transaction`
- **第 2 层（通用动态反射，3 个）**：`jlc_api_search`, `jlc_api_describe`, `jlc_api_invoke`
- **第 3 层（器件库、Datasheet 解析与确定性计算，5 个）**：`jlc_lib_search`, `jlc_lib_device_inspect`, `jlc_datasheet_extract`, `jlc_lib_custom_create`, `jlc_elec_calc`
- **第 4 层（原理图操作、标准积木与 SPICE 仿真，7 个）**：`jlc_sch_sheet_manage`, `jlc_sch_component_place`, `jlc_sch_block_instantiate`, `jlc_sch_wire_connect`, `jlc_sch_netlist_query`, `jlc_spice_run`, `jlc_sch_sync_to_pcb`
- **第 5 层（PCB 模块化布局与四级自动布线，8 个）**：`jlc_pcb_board_setup`, `jlc_pcb_cluster_netlist`, `jlc_pcb_layout_apply`, `jlc_pcb_route_critical`, `jlc_pcb_via_place`, `jlc_pcb_autoroute`, `jlc_pcb_pour_and_stitch`, `jlc_pcb_silkscreen_tidy`
- **第 6 层（电气/几何双引擎审计与视觉核验，4 个）**：`jlc_elec_lint`, `jlc_pcb_drc_and_lint`, `jlc_validate`, `jlc_view_capture`

## 构建、CLI 与测试指令

```bash
# 编译 TypeScript
npm run build

# 环境自检与生成工作区 .jlceda-mcp.json 配置
node dist/cli.js doctor --auto-configure

# 构建 REA 无伪源码全量接口索引并执行零源码审计
node dist/cli.js index --source "<JLCEDA_PRO_ASAR_PATH>" --verify-zero-source

# 校验 L3 指纹重绑定状态 / 离线审计网表
node dist/cli.js calibrate-l3
node dist/cli.js lint path/to/netlist.json

# 运行全量单元测试与黄金板卡 E2E 回归测试
npm test
```
