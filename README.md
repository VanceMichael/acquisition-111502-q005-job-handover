# 采集作业的可移交进度包与领取者交接

这是面向资料接收人员的 Node.js 收件服务。当前版本支持原始资料领取、内容校验、人工摘要登记和按出处回查，不会自动把来源正文转成领域记录。结构化自动接入尚未开放，现有人工收件仍可使用。

## 本地运行

运行环境为 Node.js 22（最低 22.22.1），使用运行时内置模块，没有第三方运行依赖。package.json 与 package-lock.json 声明相同的兼容范围；平台 Linux 基线使用 Node.js 22.23.4，独立 Dockerfile 仍固定 22.22.1 镜像摘要。启动与测试不执行依赖下载。执行以下命令启动真实收件与来源服务：

```sh
npm start
```

默认收件地址为本机 4310 端口，授权资料源为本机 4311 端口。PORT、SOURCE_PORT、ARCHIVE_DIR 可分别调整端口和资料目录；.local 为本地持久化内容，不纳入版本。停止进程后重新启动会继续读取原有收件。

## 检查与使用

```sh
npm run build
npm test
npm run demo
```

build 对所有源码做语法检查，test 检查当前已开放的收件能力和来源服务。demo 从临时空目录启动两个真实 HTTP 服务，领取实际来源，输出收件与资料索引，然后关闭并清理临时状态；不重播预先保存的日志。它没有固定等待，不超过来源请求本身的超时。当前输出只有原始收件，不能据此称自动解释已完成。

```sh
npm run acceptance:structured
npm run acceptance:partial
```

这两项检查分别在完整与不完整来源样本下，用两套独立归档目录与真实来源资格接口演练跨环境移交：导出进度包、确认包内不含会话凭据与临时游标、新环境接管、旧实例围栏、重复导入仲裁，并核对最终 collected-item 与出处回查。两项检查当前均应成功退出；结构化自动解释的观察（expected-observations）仍保持为空，现有原始收件与人工接口不受影响。完整支持范围及人工接口见 docs/service-api.md 和 docs/source-contract.md。

## 可复现环境

```sh
docker build --network=none -t local-receiver .
docker run --rm --network=none local-receiver npm test
docker run --rm --network=none local-receiver npm run demo
```

Dockerfile 固定 Linux Node 镜像摘要，容器仅需内部回环网络。镜像构建不安装额外依赖，也不读取真实账户、用户数据或公共网站；首次拉取基础镜像属于环境准备，不属于正式运行。脚本输出规模受小型本地资料控制，正常完整运行可以在九十秒内观察。

现有逐页作业可通过 /jobs、/jobs/{id}/advance 使用，具体请求字段见来源契约；跨环境移交通过 /jobs/{id}/export 与 /jobs/import 完成，进度包自带完整性校验与待领范围，支持 verify:true 先核对后接管。check:structured 和 check:partial 使用两套独立归档目录与真实来源资格接口，不把同目录重启冒充跨环境移交。

## 作业移交

维护窗口迁移未收完的作业时，不再复制工作目录（目录内含会话凭据与只对旧领取者有效的游标）。旧环境 POST /jobs/{id}/export 会先等在途页面落盘，再把作业持久化为 handed-off 围栏并输出进度包：包含全部已收件原文、收件出处、collected-item 记录、逻辑来源身份与待领范围，不含 sessionToken、临时游标或本机路径。围栏后旧进程即使重启，advance 也返回409，迟到响应无法再发表结果。

新环境先 POST /jobs/import 并带 verify:true 核对包完整性、logicalSourceId 与来源当前代次，确认 `importable` 与继续水位后，再去掉 verify 正式导入：服务复原原文与出处，向来源按代次 CAS 取得接管资格并重新 /open 会话。同一进度包重复导入只有一个有效接管者，后者收到409；恢复时重叠页内已确认条目自动跳过，不产生重复资料。核对失败（改动、缺件、逻辑来源不符）在主张资格之前拒绝，不落地任何内容。
