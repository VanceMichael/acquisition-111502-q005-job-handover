# 作业来源与移交契约

POST /jobs 接受 jobId、source（授权 origin）、actor；返回202和作业状态。POST /jobs/{id}/advance 领取一页并提交原文、collected-item 记录和稳定水位，GET /jobs/{id} 查看状态。作业状态持久在本机 jobs 目录，其中的 sessionToken、cursor 是环境绑定的临时值，不是可移交格式。

来源 /catalog 给出 logicalSourceId。POST /ownership 接受 jobId、actor、expectedGeneration 和可选 transferId，按代次比较更新资格，成功200并返回 generation/actor；代次不符409。GET /ownership?jobId=... 可核对当前资格。它是来源已有的授权领取者协调接口，不改业务资料。/open?after=N 返回此领取者会话的 cursor；after 允许重叠返回最后确认项。请求带 x-collector、x-job、x-generation；游标一次使用且只对对应领取者和代次有效。新环境必须重新建立会话。条目 id 与 sequence 稳定，原文从条目 href 获取。

## 导出：POST /jobs/{id}/export

成功200，返回 `{ transferId, bundle }`。导出在作业自身的串行队列上执行：若有一页正在收取，先等该页完整落盘再建立移交边界，因此不会漏掉进行中的那一页。边界落盘后作业状态持久变为 exported（记录导出前是 active 还是 completed），旧实例此后对 advance 一律返回409；进程重启后栅栏仍在，迟到的来源响应也没有发表通道。对已 exported 的作业重复导出返回内容一致的同一进度包，可用于核对与审计，不会改变边界。

bundle 是自描述、自校验的进度包（schemaVersion=1），包含：

- job：jobId、导出前状态、lastCommitted 稳定水位、received 已确认条目，即新机器明确续领的范围；
- source：来源 origin 与 logicalSourceId，逻辑来源身份用于跨地址核对；
- ownership：导出时来源代次 generation，供新机器做资格 CAS；
- blobs：全部已归档原文字节（base64）及其 sha256；
- receipts：原文收件元数据（含 sourceKey、revision、sha256、mediaType），receiptId 由资料集、来源键与修订派生，可独立复算；
- records：collected-item 等结构化记录及其 provenance 出处；
- manifest 与 integrity：清单覆盖水位、已收条目、原文字节摘要、收件身份与记录摘要，自身再做 sha256；transferId 由 jobId、logicalSourceId、代次、水位与清单摘要派生。

包内不含 sessionToken、临时 cursor、绝对工作目录或任何环境凭据。导入前校验可查出缺失或被改动的原文字节、收件、记录、清单与 transferId，任一不符返回400且不接管。

## 导入：POST /jobs/import

请求字段为 bundle、source、actor，成功201。处理顺序：

1. 校验包结构与整条完整性链（清单摘要、字节摘要、收件身份派生、记录摘要与出处范围、transferId 绑定）；
2. 只允许访问启动时冻结的授权 origin，非授权来源返回403；读取来源 /catalog 核对 logicalSourceId，逻辑来源不一致返回409，不凭地址相似认定相同来源；不同机器映射不同实际地址但逻辑来源一致时允许接管；
3. 以 bundle 中的代次为 expectedGeneration 向来源 POST /ownership 取得新代次，携带 transferId；代次不符（包括同一进度包已被另一 actor 接管）返回409，不写入任何资料；
4. 幂等恢复原文字节、receipts、collections 与 records（同内容重合不重复、字节身份冲突仍报409），持久化新作业状态：cursor 置空，首次 advance 以 lastCommitted 调 /open?after=N 重建会话。

同一 actor 重放同一进度包返回201且标记 duplicate，不产生第二个接管者；其他 actor 或另一独立目录重复导入同一包返回409。

## 接管后的领取语义

已移交的旧实例 advance 恒为409。新实例沿用 POST /jobs/{id}/advance：重开游标允许来源重叠返回最后确认项，已在 received 中的条目显式跳过，不重复领取、不新增重复 collected-item，水位只随新条目推进；游标返回410（迟到或失效）时按已确认水位重开会话，同样不丢页。所有原文仍可用 GET /receipts/{receiptId}/body 回查，provenance 出处关系随包完整迁移。

来源服务所有资料均为本地合成数据，会话标识是合成值，不使用真实凭据。
