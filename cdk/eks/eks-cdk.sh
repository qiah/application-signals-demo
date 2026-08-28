#!/bin/bash

# Script to synthesize, deploy, or destroy AWS CDK stacks with stack dependencies
# Usage: ./cdk-deploy.sh <action> [destroy-on-fail]
#
# Parameters:
#   action         - Required: 'synth', 'deploy', or 'destroy'
#   destroy-on-fail - Optional: 'true' or 'false' (default: true) - Destroy all stacks if deployment fails
#
# Examples:
#   ./cdk-deploy.sh deploy                        - Deploy with default settings
#   ./cdk-deploy.sh deploy false                  - Deploy and keep stacks on failure
#   ./cdk-deploy.sh destroy                       - Destroy all stacks
#   ./cdk-deploy.sh synth                         - Only synthesize CloudFormation templates

ACTION=$1
DESTROY_ON_FAIL=${2:-true}  # Default to true for backward compatibility

# Check for action parameter
if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 <action> [destroy-on-fail]"
  echo ""
  echo "Parameters:"
  echo "  action         - Required: 'synth', 'deploy', or 'destroy'"
  echo "  destroy-on-fail - Optional: 'true' or 'false' (default: true)"
  echo ""
  echo "Examples:"
  echo "  $0 deploy                        - Deploy with default settings"
  echo "  $0 deploy false                  - Deploy and keep stacks on failure"
  exit 1
fi

# Run CDK synth once for all stacks
if [[ "$ACTION" == "synth" || "$ACTION" == "deploy" ]]; then
  npm install
  echo "Running CDK bootstrap"
  cdk bootstrap

  rm -rf cdk.out
  echo "Running CDK synth for all stacks..."
  if cdk synth --context enableSlo=True ; then
    echo "CDK synth successful!"
    if [[ "$ACTION" == "synth" ]]; then
      exit 0
    fi
  else
    echo "CDK synth failed. Exiting."
    exit 1
  fi
fi

# Deploy or destroy all stacks in the app
if [[ "$ACTION" == "deploy" ]]; then
  # The SLO stack requires metrics from lambda pet clinic.
  cd ../../lambda-petclinic/cdk
  if ./deploy.sh; then
    echo "Lambda pet clinic was deployed successfully"
  else
    echo "Lambda pet clinic deployment failed"
    ./destroy.sh
    exit 1
  fi
  cd ../../lambda-audit-service/cdk
  if ./cdk.sh deploy; then
    echo "Lambda audit service was deployed successfully"
  else
    echo "Lambda audit service deployment failed"
    ./cdk.sh destroy
    exit 1
  fi
  cd ../../cdk/eks

  echo "Starting CDK deployment for all stacks in the app"
  # Deploy the EKS cluster with the sample app first
  if cdk deploy --all --require-approval never; then
    echo "Deployment successful for sample app in EKS Cluster"

    # Once the sample app is deployed, it will take up to 10 minutes for SLO metrics to appear
    sleep 600
    if cdk deploy --context enableSlo=True --all --require-approval never; then
      echo "Synthetic canary and SLO was deployed successfully"
    else
      echo "Synthetic canary and SLO failed to deploy"
      if [[ "$DESTROY_ON_FAIL" == "true" ]]; then
        echo "DESTROY_ON_FAIL is set to true, destroying all stacks..."
        cdk destroy --context enableSlo=True --all --force --verbose
      else
        echo "DESTROY_ON_FAIL is set to false, keeping existing stacks for debugging..."
      fi
      exit 1
    fi
  else
    echo "Deployment failed."
    if [[ "$DESTROY_ON_FAIL" == "true" ]]; then
      echo "DESTROY_ON_FAIL is set to true, attempting to clean up resources by destroying all stacks..."
      cdk destroy --all --force --verbose
    else
      echo "DESTROY_ON_FAIL is set to false, keeping existing stacks for debugging..."
    fi
    exit 1
  fi
elif [[ "$ACTION" == "destroy" ]]; then
  echo "Starting CDK destroy for all stacks in the eks app"
  cdk destroy  --context enableSlo=True --all --force --verbose
  echo "Destroy complete for all stacks in the eks app"
  echo "Starting CDK destroy for all stacks in the lambda app"
  cd ../../lambda-petclinic/cdk
  ./destroy.sh
  echo "Destroy complete for all stacks in the lambda app"
  echo "Starting CDK destroy for audit service"
  cd ../../lambda-audit-service/cdk
  ./cdk.sh destroy
  echo "Destroy complete for audit service"
else
  echo "Invalid action: $ACTION. Please use 'synth', 'deploy', or 'destroy'."
  exit 1
fi
