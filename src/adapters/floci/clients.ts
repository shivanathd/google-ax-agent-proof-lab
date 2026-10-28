// Real AWS SDK v3 clients aimed at the run's Floci container. Endpoint is checked at construction and
// again on every request; credentials are the injected fakes, never the default provider chain.
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { SQSClient, CreateQueueCommand } from "@aws-sdk/client-sqs";
import { assertAllowedEndpoint, guardAwsClient, type OnReject } from "../../config/endpoints.ts";
import { FAKE_AWS_CREDENTIALS } from "../../config/env.ts";
import type { Endpoint } from "../../config/run-config.ts";

export interface FlociClients { s3: S3Client; sqs: SQSClient; endpoint: string }

export async function flociClients(endpoint: string, allowlist: Endpoint[], onReject?: OnReject): Promise<FlociClients> {
  await assertAllowedEndpoint(endpoint, allowlist, onReject);
  // maxAttempts 1: retries are explicit, bounded and only for known-safe operations (C1 limits).
  const cfg = { endpoint, region: "us-east-1", forcePathStyle: true, credentials: FAKE_AWS_CREDENTIALS, maxAttempts: 1 };
  return {
    endpoint,
    s3: guardAwsClient(new S3Client(cfg), allowlist, onReject),
    sqs: guardAwsClient(new SQSClient(cfg), allowlist, onReject),
  };
}

// Per-run namespaces; each run also has its own Floci container, so names never collide across runs.
export const resourceNames = (project: string) => ({ queue: `${project}-jobs`, bucket: `${project}-receipts` });

export async function ensureRunResources(c: FlociClients, project: string) {
  const names = resourceNames(project);
  await c.s3.send(new CreateBucketCommand({ Bucket: names.bucket })).catch((e) => {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e?.name))) throw e;
  });
  const q = await c.sqs.send(new CreateQueueCommand({ QueueName: names.queue, Attributes: { VisibilityTimeout: "1" } }));
  return { ...names, queueUrl: q.QueueUrl! };
}
