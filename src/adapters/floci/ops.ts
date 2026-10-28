// Floci S3 receipts and SQS jobs through the real AWS SDK; no in-memory substitute exists in this repo.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message } from "@aws-sdk/client-sqs";
import { assertAllowed, type ActionEnvelope } from "../../policy/index.ts";
import type { FlociClients } from "./clients.ts";

export async function putReceipt(c: FlociClients, env: ActionEnvelope, body: string) {
  assertAllowed(env, "receipt.put");
  const { bucket, key } = env.input as { bucket: string; key: string };
  await c.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
}

export async function getObjectText(c: FlociClients, bucket: string, key: string): Promise<string | undefined> {
  try {
    return await (await c.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToString();
  } catch (e) {
    if ((e as Error).name === "NoSuchKey") return undefined;
    throw e;
  }
}

export const sendJob = (c: FlociClients, queueUrl: string, body: string) => c.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));

export async function receiveJobs(c: FlociClients, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const r = await c.sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: 5, WaitTimeSeconds: waitSeconds, MessageSystemAttributeNames: ["ApproximateReceiveCount"],
  }));
  return r.Messages ?? [];
}

export const deleteJob = (c: FlociClients, queueUrl: string, receiptHandle: string) =>
  c.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
