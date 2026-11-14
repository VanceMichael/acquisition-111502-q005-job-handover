# 作业来源与移交契约

当前 POST /jobs 接受 jobId、source（授权 origin）、actor；返回202和作业状态。POST /jobs/{id}/advance 领取一页并提交原文、collected-item 记录和稳定水位，GET /jobs/{id} 查看状态。当前支持同机逐页接收，不支持导出或导入。src/jobs.mjs 保存了本机作业状态，不能把它当作现成的可移交格式。

来源 /catalog 给出 logicalSourceId。POST /ownership 接受 jobId、actor、expectedGeneration 和可选 transferId，按代次比较更新资格，成功200并返回 generation/actor；代次不符409。GET /ownership?jobId=... 可核对当前资格。它是来源已有的授权领取者协调接口，不改业务资料。/open?after=N 返回此领取者会话的 cursor；after 允许重叠返回最后确认项。请求带 x-collector、x-job、x-generation；游标一次使用且只对对应领取者和代次有效。新环境必须重新建立会话。条目 id 与 sequence 稳定，原文从条目 href 获取。

新增 POST /jobs/{id}/export，成功200返回 bundle。它应形成有版本、有完整性校验的进度包，并明确旧作业不可再推进的边界。bundle 需携带原始收件、正文及待完成范围的可验证关系，不含 sessionToken、临时 cursor、绝对工作目录或环境凭据。可自行设计包内结构与校验布局，但必须能查出缺失或被改动的原文字节，保留原有出处，不仅导出一份状态摘要。

POST /jobs/import 接受 bundle、source、actor，成功201。导入前核对包完整性与 logicalSourceId，并向来源取得新资格；同一进度包被另一个 actor 接管后再次导入返回409，不得覆盖原作业。POST /jobs/{id}/advance 在已移交的旧实例返回409，旧响应不能重新发表。新实例继续现有 advance 接口，重复补领不新增已有 collected-item。原文仍用 GET /receipts/{receiptId}/body 回查。不同机器可映射不同的实际地址，但逻辑来源不一致应拒绝，不能凭地址相似认定相同。

移交期间如何建立稳定边界、表示未完成工作、恢复失败导入并防止旧领取者复活，由实现决定；允许短暂停顿，不允许丢页或重写旧原文。来源服务所有资料均为本地合成数据，会话标识是合成值，不使用真实凭据。
