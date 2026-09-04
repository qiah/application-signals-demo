# Introduction
This is a modified version of the [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices) Spring Boot sample application.
If your interest lies in exploring the broader aspects of the Spring Boot stack, we recommend visiting the original repository at [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices).

**This fork is instrumented with CloudWatch Omni (OpenTelemetry / ADOT), following the CloudWatch Omni
instrumentation guide.** The PetClinic microservices export OTLP traces, logs, and metrics on every platform below (EC2, ECS, EKS, and Bedrock AgentCore), and the deploy scripts enable the prerequisites for you (X-Ray Transaction Search; the EC2 telemetry rule). Deploy to your own AWS account, generate traffic, and the services appear in the CloudWatch console. See **[How to verify your telemetry](#how-to-verify-your-telemetry)** for exactly what lands where.

> This is a fork of `aws-observability/application-signals-demo` with the Application Signals / ADOT
> instrumentation replaced by the CloudWatch Omni (OTel) path. The in-instance `git clone` in the EC2 and K8s
> user-data points at this fork's `omni-demo` branch; if you fork it, update that URL/branch.

# Disclaimer

This code for sample application is intended for demonstration purposes only. It should not be used in a production environment or in any setting where reliability/security is a concern.

# Prerequisite

## Option 1: Using AWS CodeBuild (Recommended - No Local Setup Required)
* AWS CLI 2.x is installed. For more information about installing the AWS CLI, see [Install or update the latest version of the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
* AWS CDK CLI: the EC2 and Agents apps pin their own CLI (`aws-cdk` devDependency, run via `npx cdk`), so no global install is needed for them. Other apps: AWS CDK >= v2.1139.0 is installed - https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_install
* Node.js >= v18.0.0 is installed.

## Option 2: Local Build Environment
* A Linux machine with x86-64 (AMD64) architecture is required for building Docker images for the sample application.
* Docker is installed and running on the machine. Finch works too: `export CDK_DOCKER=finch` before running the scripts.
* AWS CLI 2.x is installed. For more information about installing the AWS CLI, see [Install or update the latest version of the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

## Additional Prerequisites for Deployment
* kubectl is installed - https://docs.aws.amazon.com/eks/latest/userguide/install-kubectl.html
* eksctl is installed - https://docs.aws.amazon.com/eks/latest/userguide/eksctl.html
* jq is installed - https://jqlang.github.io/jq/download/
* AWS CDK CLI: the EC2 and Agents apps pin their own CLI (`aws-cdk` devDependency, run via `npx cdk`), so no global install is needed for them. Other apps: AWS CDK >= v2.1139.0 is installed - https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_install
* Node.js >= v18.0.0 is installed.
* [Optional] If you plan to install the infrastructure resources using Terraform, terraform cli is required. https://developer.hashicorp.com/terraform/tutorials/aws-get-started/install-cli
* [Optional] If you want to try out the AWS Bedrock/GenAI parts of the demo, enable Amazon Titan, Anthropic Claude, Meta Llama foundation models by following the instructions in https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html
# EKS demo

## Deploy via Shell Scripts

### Build the sample application images and push to ECR

#### Option 1: Using AWS CodeBuild (Recommended - No Local Build Environment Required)

AWS CodeBuild eliminates the need for local Docker and build tools. The build process runs entirely in AWS.

1. Deploy the CodeBuild infrastructure. Replace `region-name` with your desired AWS region (e.g., `us-east-1`):

``` shell
cd cdk/codebuild
npm install
export AWS_REGION=region-name  # Set your desired region
cdk bootstrap  # First time only - bootstraps CDK in the specified region
cdk deploy     # Deploys the CodeBuild stack to the specified region
```

   To clean up the CodeBuild infrastructure when no longer needed:
   ``` shell
   cd cdk/codebuild
   export AWS_REGION=region-name  # Use the same region where you deployed
   cdk destroy
   ```
   This will remove the CodeBuild project, S3 bucket, IAM roles, and CloudWatch logs. Note: ECR repositories with Docker images are not deleted automatically.

2. Trigger a build to create and push all images to ECR. Replace `region-name` with the region you choose (e.g. `us-east-1`)

``` shell
./scripts/trigger-build.sh --region region-name 
```

For more details, see the [CodeBuild README](cdk/codebuild/README.md).

#### Option 2: Local Build

1. Build container images for each micro-service application

``` shell
./mvnw clean install -P buildDocker
```

2. Create an ECR repo for each micro service and push the images to the relevant repos. Replace the aws account id and the AWS Region.

``` shell
export ACCOUNT=`aws sts get-caller-identity | jq .Account -r`
export REGION='us-east-1'
./push-ecr.sh
```

### Deploy the sample application
1. Set up a EKS cluster and deploy sample app. Replace `region-name` with the region you choose.

   ``` shell
   cd scripts/eks/appsignals && ./setup-eks-demo.sh --region=region-name
   ``` 

2. Access the EKS cluster using kubectl to check pod status and logs:

   ```shell
   # Configure kubectl to use the EKS cluster
   aws eks update-kubeconfig --name eks-pet-clinic-demo --region <your-region> --role-arn arn:aws:iam::<your-account>:role/PetClinicEksClusterRole

   # View the microservices pods
   kubectl get pods -n pet-clinic

   # Get the ingress URL
   kubectl get svc -n ingress-nginx | grep "ingress-nginx" | awk '{print $4}'
   ```

3. Clean up after you are done with the sample app. Replace `region-name` with the same value that you use in previous step.
   ```
   cd scripts/eks/appsignals/ && ./setup-eks-demo.sh --operation=delete --region=region-name
   ```

Please be aware that this sample application includes a publicly accessible Application Load Balancer (ALB), enabling easy interaction with the application. If you perceive this public ALB as a security risk, consider restricting access by employing [security groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html).


# How to verify your telemetry

Once a platform is deployed and receiving traffic, the CloudWatch Omni path creates these log groups
automatically (nothing to pre-create). Use them to confirm telemetry is flowing:

| Signal | Log group | Platforms |
|---|---|---|
| Traces (spans) | `aws/spans` | EC2, ECS, EKS, AgentCore |
| Application Signals (derived RED metrics) | `/aws/application-signals/data` | all, via Transaction Search |
| App logs over OTLP (EC2 / ECS) | `/aws/cwagent/otlp` | EC2, ECS |
| App logs over OTLP (EKS) | `/aws/cwagent/<clusterName>/otlp` | EKS (cluster-scoped) |
| Agent runtime logs + spans | `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` | AgentCore |


For Bedrock AgentCore the agents emit telemetry only when invoked. The deployed traffic generator (an
EventBridge-scheduled Lambda) invokes the primary agent runtime directly every minute, so spans flow
continuously after deploy — the primary agent delegates to the nutrition agent, so both appear. To invoke a
runtime yourself:

```shell
aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn <RUNTIME_ARN> \
  --runtime-session-id $(uuidgen) --payload '{"prompt":"What are the clinic hours?"}' \
  --content-type application/json --accept application/json /dev/stdout
```

# EC2 Demo
The following instructions describe how to set up the pet clinic sample application on EC2 instances. You can run these steps in your personal AWS account to follow along (Not recommended for production usage).

1. Create resources and deploy sample app. Replace `region-name` with the region you choose.
   ```
   cd scripts/ec2/appsignals/ && ./setup-ec2-demo.sh --region=region-name
   ```


2. Clean up after you are done with the sample app. Replace `region-name` with the same value that you use in previous step.
   ```
   cd scripts/ec2/appsignals/ && ./setup-ec2-demo.sh --operation=delete --region=region-name
   ```


# K8s Demo
The following instructions set up an kubernetes cluster on 2 EC2 instances (one master and one worker node) with kubeadmin and deploy the pet clinic sample application to the cluster. You can run these steps in your personal AWS account to follow along (Not recommended for production usage). 

1. Build container images and push them to public ECR repo

   ``` shell
   ./mvnw clean install -P buildDocker && ./push-public-ecr.sh
   ```

2. Set up a kubernetes cluster and deploy sample app. Replace `region-name` with the region you choose.

   ``` shell
   cd scripts/k8s/appsignals/ && ./setup-k8s-demo.sh --region=region-name
   ``` 

3. Clean up after you are done with the sample app. Replace `region-name` with the same value that you use in previous step.
   ```
   cd scripts/k8s/appsignals/ && ./setup-k8s-demo.sh --operation=delete --region=region-name


# ECS Demo
The following instructions set up an ECS cluster with all services running in Fargate. You can run these steps in your personal AWS account to follow along (Not recommended for production usage).

1. Build container images and push them to private ECR repo. Replace `region-name` with the region you choose.
   ```shell
   export ACCOUNT=`aws sts get-caller-identity | jq .Account -r`
   export REGION=region-name
   ```
   ``` shell
   ./mvnw clean install -P buildDocker && ./push-ecr.sh
   ```

2. Set up a ECS cluster and deploy sample app. Replace `region-name` with the region you choose.

   ``` shell
   cd scripts/ecs/appsignals && ./setup-ecs-demo.sh --region=region-name
   ``` 

3. Clean up after you are done with the sample app. Replace `region-name` with the same value that you use in previous step.
   ```
   cd scripts/ecs/appsignals/ && ./setup-ecs-demo.sh --operation=delete --region=region-name
   ```

# Bedrock AgentCore Runtime Demo

The following instructions set up AI agents deployed to Bedrock AgentCore Runtime. You can run these steps in your personal AWS account to follow along (Not recommended for production usage). 

The setup includes:

- **Primary Agent**: A general pet clinic assistant that handles appointment scheduling, clinic information, and emergency contacts. Any nutrition related queries will be delegated to the Nutrition Agent.
- **Nutrition Agent**: A specialized agent focused on pet nutrition, diet recommendations, and feeding guidelines. When deployed with the Pet Clinic EKS demo, it utilizes the pet clinic service API to base its answers on data from the service
- **Traffic Generator**: A Lambda function scheduled via AWS EventBridge that sends queries to the Primary Agent on set a cadence.

**Prerequisites:**
- AWS CLI 2.x configured with appropriate permissions
- AWS CDK >= v2.1024.0 installed
- Node.js >= v18.0.0 installed
- Docker installed and running (for building agent container images)
- Access to Amazon Bedrock foundation models (Claude 3.5 Haiku recommended)

## Setup Instructions

1. **Deploy the agents and traffic generator**. Replace `region-name` with your desired AWS region (e.g., `us-east-1`):

   ```shell
   cd scripts/agents && ./setup-agents-demo.sh --region=region-name
   ```

   The Nutrition Agent relies on the pet clinic service to retrieve pet nutrition information and provide accurate dietary recommendations. To enable this feature:
   
   - The [EKS demo](#eks-demo) must be set up first
   - **The pet clinic service must be exposed as an ingress service** with a publicly accessible URL for the agent to connect to it
   
   The deployment script will attempt to auto-discover the pet clinic service endpoint from your EKS cluster. If auto-discovery fails or you want to specify a custom endpoint, you can manually provide the pet clinic service URL using the `--pet-clinic-url` parameter:

   ```shell
   export MY_PET_CLINIC_ENDPOINT=my-load-balancer.us-east-1.elb.amazonaws.com

   cd scripts/agents && ./setup-agents-demo.sh --region=us-east-1 --pet-clinic-url=http://${MY_PET_CLINIC_ENDPOINT}
   ```

2. **Clean up resources** when finished:

   ```shell
   cd scripts/agents && ./setup-agents-demo.sh --operation=delete --region=region-name
   ```