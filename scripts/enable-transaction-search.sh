#!/bin/bash
# Enable X-Ray Transaction Search for the region (idempotent). Spans over OTLP are
# silently HTTP-400 dropped unless the trace segment destination is CloudWatch Logs
# (default is XRay). Called automatically by the setup-*-demo.sh scripts.
# Usage: ./enable-transaction-search.sh <region>
set -uo pipefail
REGION="${1:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"

DEST="$(aws xray get-trace-segment-destination --region "$REGION" --query 'Destination' --output text 2>/dev/null)"
if [ "$DEST" = "CloudWatchLogs" ]; then
  echo "X-Ray Transaction Search already enabled (CloudWatch Logs)."
  exit 0
fi
if [ -z "$DEST" ] || [ "$DEST" = "None" ]; then
  echo "WARNING: cannot query X-Ray trace segment destination (AWS CLI may be too old)."
  echo "         Enable Transaction Search manually so spans are not dropped."
  exit 0
fi

echo "Enabling X-Ray Transaction Search (CloudWatch Logs) in $REGION ..."
read -r -d '' POLICY <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"SpansFromXray","Effect":"Allow","Principal":{"Service":"xray.amazonaws.com"},
  "Action":["logs:PutLogEvents","logs:CreateLogStream"],
  "Resource":"arn:aws:logs:${REGION}:${ACCOUNT}:log-group:aws/spans:*",
  "Condition":{"StringEquals":{"aws:SourceAccount":"${ACCOUNT}"},"ArnEquals":{"aws:SourceArn":"arn:aws:xray:${REGION}:${ACCOUNT}:*"}}},
 {"Sid":"AppSignalsEmfFromXray","Effect":"Allow","Principal":{"Service":"xray.amazonaws.com"},
  "Action":["logs:PutLogEvents","logs:CreateLogStream"],
  "Resource":"arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/application-signals/data:*",
  "Condition":{"StringEquals":{"aws:SourceAccount":"${ACCOUNT}"},"ArnEquals":{"aws:SourceArn":"arn:aws:xray:${REGION}:${ACCOUNT}:*"}}}]}
JSON
aws logs put-resource-policy --policy-name "XRayToLogsIngestion-omni" --policy-document "$POLICY" --region "$REGION" >/dev/null 2>&1 \
  || echo "WARNING: could not put CloudWatch Logs resource policy for X-Ray."
aws xray update-trace-segment-destination --destination CloudWatchLogs --region "$REGION" >/dev/null 2>&1 \
  && echo "Trace segment destination set to CloudWatch Logs (a few minutes to become ACTIVE)." \
  || echo "WARNING: update-trace-segment-destination failed; enable Transaction Search manually."
