import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob } from "../types.js";
import { logWarn } from "./run-execution.runtime.js";

type FallbackResolvedCronDelivery = {
  ok?: boolean;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
};

export function resolveFallbackCronSourceDeliveryPlan(params: {
  job: CronJob;
  resolvedDelivery: FallbackResolvedCronDelivery;
}) {
  logWarn(
    `[cron:${params.job.id}] sourceDelivery is undefined; using fallback - possible build artifact mismatch`,
  );

  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const target = {
    channel: params.resolvedDelivery.channel,
    to: params.resolvedDelivery.to,
    accountId: params.resolvedDelivery.accountId,
    threadId: params.resolvedDelivery.threadId,
  };

  if (deliveryPlan.mode === "webhook") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_webhook",
      messageToolEnabled: false,
      directFallback: false,
    });
  }

  if (deliveryPlan.mode === "none") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target,
      messageToolEnabled: true,
      messageToolForced: false,
      directFallback: false,
    });
  }

  return createSourceDeliveryPlan({
    owner: "direct_fallback",
    reason: "cron_announce",
    target,
    messageToolEnabled: true,
    messageToolForced: false,
    directFallback: true,
    skipFallbackWhenMessageToolSentToTarget: params.resolvedDelivery.ok,
  });
}
