# 作业来源与移交契约

当前 POST /jobs 接受 jobId、source（授权 origin）、actor；返回202和作业状态。POST /jobs/{id}/advance 领取一页并提交原文、collected-item 记录和稳定水位，GET /jobs/{id} 查看状态。src/jobs.mjs 保存本机作业状态；正式移交只通过下述进度包进行，不直接复制工作目录或作业状态文件。

来源 /catalog 给出 logicalSourceId。POST /ownership 接受 jobId、actor、expectedGeneration 和可选 transferId，按代次比较更新资格，成功200并返回 generation/actor；代次不符409。GET /ownership?jobId=... 可核对当前资格。它是来源已有的授权领取者协调接口，不改业务资料。/open?after=N 返回此领取者会话的 cursor；after 允许重叠返回最后确认项。请求带 x-collector、x-job、x-generation；游标一次使用且只对对应领取者和代次有效。新环境必须重新建立会话。条目 id 与 sequence 稳定，原文从条目 href 获取。

## 进度包导出 POST /jobs/{id}/export

成功200返回 `{ transferId, logicalSourceId, lastCommitted, received, bundle }`。导出与同作业的 advance 共用串行队列：在途页面全部落盘后才冻结边界，允许短暂停顿但不会切断正在收取的一页。导出同时把作业持久化为 handed-off 围栏状态（cursor 清空、不保留 sessionToken），该状态落盘，进程重启后仍然生效；此后 POST /jobs/{id}/advance 一律返回409，迟到的旧代次来源响应也无法再发表结果。围栏作业允许再次导出（例如运维在来源侧重新协调资格后），重新导出会读取来源当前代次并生成新的 transferId。

bundle 为自描述、自校验的 JSON：顶层 integrity 是对其余内容规范序列化的 SHA-256；archive.manifest 逐件列出 receiptId、sha256、byteLength；archive.entries 携带每件收件元数据、原文 contentBase64 与稳定出处 sourceKey/revision；job 段给出 generation、lastCommitted、received 与待领范围 pending（after、resumePath、knownItemCount、remaining）。包内不出现 sessionToken、临时 /cursor、绝对工作目录或环境凭据；同资料集、来源键与修订的收件标识可在新环境重新推导并逐一核对。

## 进度包导入与核对 POST /jobs/import

请求字段为 bundle、source、actor，另可传 verify:true 只核对不接管。处理顺序固定：先做包完整性校验（顶层摘要、每段原文字节摘要、收件身份与出处/修订的推导关系、清单闭环、received 与 collected-item 记录一致性），再读取来源 /catalog 比对 logicalSourceId，再用 GET /ownership 比对代次；任何缺失、改动或逻辑来源不符都在主张资格之前拒绝（完整性问题400，代次不符409），不在目标环境落地资料集、也不向来源主张接管。逻辑来源不一致（即使地址可达且相似）返回 logical_source_mismatch，不能凭地址认定相同来源。

verify:true 返回200与 `{ importable, verification }`，verification 含 sourceMatches、generationMatches、currentGeneration、currentActor、已接收与待领范围、收件与记录计数，供运维核对包是否完整、是否仍适用于该来源，并明确应从 lastCommitted 之后哪一段继续，而不是从头重采。

正式导入（无 verify）在核对通过后先把原文与出处原子复原到新归档（同包重放幂等、异己内容409且不覆盖），再以包内 generation 为 expectedGeneration、transferId 为凭据向来源 POST /ownership 取得新代次资格，随后 /open?after=lastCommitted 建立全新会话并保存作业。来源的代次 CAS 是唯一接管仲裁：同一进度包被第二个 actor 或另一独立目录再次导入时，来源代次已前进，必然409，因此同一包只能有一个有效接管者。新实例继续使用现有 advance 接口；重叠页中已在 received 内的条目直接跳过，不重复领取原文、不重复登记 collected-item 或收件。原文仍可用 GET /receipts/{receiptId}/body 回查。不同机器可映射不同实际地址，只要 logicalSourceId 一致即可。

移交期间如何建立稳定边界、表示未完成工作、恢复失败导入并防止旧领取者复活，由实现决定；允许短暂停顿，不允许丢页或重写旧原文。来源服务所有资料均为本地合成数据，会话标识是合成值，不使用真实凭据。
