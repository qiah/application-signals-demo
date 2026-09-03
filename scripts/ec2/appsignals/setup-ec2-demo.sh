#!/bin/bash
set -ex

# Default values
DEFAULT_REGION="us-east-1"
OPERATION="create"
DESTROY_ON_FAIL="true"  # --destroy-on-fail=false keeps failed stacks for debugging

# Read command line arguments
for i in "$@"; do
  case $i in
  --operation=*)
    OPERATION="${i#*=}"
    shift # past argument=value
    ;;
  --region=*)
    REGION="${i#*=}"
    shift # past argument=value
    ;;
  --destroy-on-fail=*)
    DESTROY_ON_FAIL="${i#*=}"
    shift # past argument=value
    ;;
  *)
    # unknown option
    ;;
  esac
done

# Set region with provided value or default
REGION="${REGION:-$DEFAULT_REGION}"

export AWS_DEFAULT_REGION=$REGION

function run_cdk() {
  echo "Running CDK..."
  # jump to the cdk folder, run the cdk commands, and then jump back to current folder
  pushd ../../../cdk/ec2 >/dev/null
  ./ec2-cdk.sh $1 $DESTROY_ON_FAIL
  popd >/dev/null
}

function delete_resources() {
  echo "Deleting resources..."

  run_cdk destroy

  # delete resources created by the sample app itself
  aws sqs delete-queue --queue-url $(aws sqs get-queue-url --queue-name apm_test --query 'QueueUrl' --output text)
  aws kinesis delete-stream --stream-name apm_test 
  aws dynamodb delete-table --table-name apm_test 
  aws dynamodb delete-table --table-name BillingInfo 
  aws dynamodb delete-table --table-name PetClinicPayment 

  echo "Resource deletion complete."
}

# Execute based on operation
if [ "$OPERATION" == "delete" ]; then
  delete_resources
else
  # Enable X-Ray Transaction Search (idempotent) so OTLP spans are not rejected.
  bash "$(dirname "$0")/../../../scripts/enable-transaction-search.sh" "$REGION"
  run_cdk deploy
fi
