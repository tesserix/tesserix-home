# OpenBao recovery controls

`OPENBAO_RECOVERY_BUCKET` enables the recovery integration in-cluster. Without
it, recovery endpoints return 503 while existing secret operations remain available.

`GET /api/recovery` requires the platform capability. It returns up to three
verified snapshot metadata entries and the latest 20 labelled recovery Jobs.
`jobsComplete=false` means the bounded Job listing was truncated.

`POST /api/recovery/jobs` additionally requires rotate-credentials. The JSON body
accepts only `operation` (`backup` or `restore-test`) and `idempotencyKey`
(16–128 ASCII letters, digits, underscores or hyphens). Reuse the key after an
uncertain response. Job names are deterministic per authenticated actor, operation
and key; retries within the Job's two-day lifetime return the same Job. Production
restore is not exposed.

The console page is `/platform/secrets/recovery`. Server actions repeat live
capability checks and forward the existing operator bearer token. Next.js's
same-origin server action protection applies. Both layers record audit events.
The API copies only the fixed CronJob templates in `openbao-recovery`; Kubernetes
admission independently rejects changed pod specifications. Its Workload Identity
can read only `catalog.json`, never snapshot objects. Responses omit object paths,
marker values, pod specs and logs.

Deploy the matching recovery admission/RBAC chart before enabling the API. Deploy
the API before the console. Rollback by restoring the previous API image and
removing the recovery bucket setting; scheduled backups continue independently.
See tesserix-k8s/docs/openbao-recovery.md for recovery operations and live evidence.
