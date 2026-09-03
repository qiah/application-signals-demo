const { Stack, RemovalPolicy } = require('aws-cdk-lib');
const ecrAssets = require('aws-cdk-lib/aws-ecr-assets');
const iam = require('aws-cdk-lib/aws-iam');
const { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } = require('aws-cdk-lib/custom-resources');
const { BedrockAgentCoreDeployer } = require('./bedrock-agentcore-deployer');

/**
 * CDK Stack that deploys the Pet Clinic Agents images to ECR and creates Bedrock AgentCore Runtime instances
 * for those images. AgentCore Runtime is a containerized host service for AI agents that processes user inputs,
 * maintains context, and executes actions using AI capabilities.
 * 
 * See: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html
 */
class PetClinicAgentsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const account = this.account;
    const region = this.region;


    // X-Ray Transaction Search (OTLP spans are rejected with HTTP 400 unless the trace segment destination is
    // CloudWatch Logs). Done here as custom resources so it does not depend on the operator's AWS CLI version.
    const spansPolicy = new AwsCustomResource(this, 'OmniXRayToLogsPolicy', {
      onCreate: {
        service: 'cloudwatch-logs', action: 'PutResourcePolicy',
        parameters: {
          policyName: 'XRayToLogsIngestion-omni',
          policyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [
            { Sid: 'SpansFromXray', Effect: 'Allow', Principal: { Service: 'xray.amazonaws.com' },
              Action: ['logs:PutLogEvents', 'logs:CreateLogStream'],
              Resource: `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
              Condition: { StringEquals: { 'aws:SourceAccount': this.account }, ArnEquals: { 'aws:SourceArn': `arn:aws:xray:${this.region}:${this.account}:*` } } },
            { Sid: 'AppSignalsEmfFromXray', Effect: 'Allow', Principal: { Service: 'xray.amazonaws.com' },
              Action: ['logs:PutLogEvents', 'logs:CreateLogStream'],
              Resource: `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/application-signals/data:*`,
              Condition: { StringEquals: { 'aws:SourceAccount': this.account }, ArnEquals: { 'aws:SourceArn': `arn:aws:xray:${this.region}:${this.account}:*` } } },
          ] }),
        },
        physicalResourceId: PhysicalResourceId.of('omni-xray-to-logs-policy'),
      },
      installLatestAwsSdk: true,
      policy: AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ['logs:PutResourcePolicy'], resources: ['*'] })]),
    });
    const traceDestination = new AwsCustomResource(this, 'OmniTraceDestination', {
      onCreate: {
        service: 'xray', action: 'UpdateTraceSegmentDestination', parameters: { Destination: 'CloudWatchLogs' },
        physicalResourceId: PhysicalResourceId.of('omni-trace-destination'),
        ignoreErrorCodesMatching: 'InvalidRequestException|ConflictException',
      },
      installLatestAwsSdk: true,
      policy: AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ['xray:UpdateTraceSegmentDestination', 'xray:GetTraceSegmentDestination', 'logs:PutRetentionPolicy', 'logs:CreateLogGroup', 'logs:DescribeLogGroups'], resources: ['*'] })]),
    });
    traceDestination.node.addDependency(spansPolicy);

    // Create Bedrock AgentCore execution role:
    // See: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html
    const agentCoreRole = new iam.Role(this, 'BedrockAgentCoreRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      roleName: 'PetClinicBedrockAgentCoreRole',
      inlinePolicies: {
        AgentCorePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchGetImage',
                'ecr:GetDownloadUrlForLayer',
                'ecr:GetAuthorizationToken'
              ],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents'
              ],
              resources: [`arn:aws:logs:${region}:${account}:*`]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock-agentcore:*'
              ],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream'
              ],
              resources: ['*']
            }),
            // Omni guide > AgentCore > "Enable trace delivery" > IAM for AgentCore (CDK-TS case, verbatim actions)
            new iam.PolicyStatement({
              actions: ['xray:GetSamplingRules', 'xray:GetSamplingTargets',
                        'xray:PutTelemetryRecords', 'xray:PutTraceSegments'],
              resources: ['*'],
            }),
          ]
        })
      }
    });
    
    const nutritionAgentImage = new ecrAssets.DockerImageAsset(this, 'NutritionAgentImage', {
      directory: '../../pet_clinic_ai_agents/nutrition_agent'
    });

    const primaryAgentImage = new ecrAssets.DockerImageAsset(this, 'PrimaryAgentImage', {
      directory: '../../pet_clinic_ai_agents/primary_agent'
    });

    // Omni guide > AgentCore > "Enable trace delivery" > CDK (TypeScript) environmentVariables, verbatim values.
    // OTEL_SERVICE_NAME must be {RuntimeName}.{EndpointName}; the runtime endpoint is DEFAULT.
    const omniObservabilityEnv = (runtimeName) => ({
      AGENT_OBSERVABILITY_ENABLED: 'true',                 // raw IaC: set it (the toolkit sets it for you)
      AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT: 'true',        // non-prod: keep prompt content in span attrs
      OTEL_SERVICE_NAME: `${runtimeName}.DEFAULT`,         // {RuntimeName}.{EndpointName}
      OTEL_TRACES_EXPORTER: 'otlp',                        // REQUIRED on a raw CfnRuntime
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=demo',
      OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '65536',          // large prompts truncate otherwise
    });
    // Deploy nutrition agent with optional environment variable
    const nutritionAgentName = 'nutrition_agent';
    const nutritionAgentProps = {
      AgentName: nutritionAgentName,
      ImageUri: nutritionAgentImage.imageUri,
      ExecutionRole: agentCoreRole.roleArn,
      Entrypoint: 'nutrition_agent.py',
      EnvironmentVariables: { ...omniObservabilityEnv(nutritionAgentName) }
    };
    
    if (props?.nutritionServiceUrl) {
      nutritionAgentProps.EnvironmentVariables.NUTRITION_SERVICE_URL = props.nutritionServiceUrl;
    }
    
    const nutritionAgent = new BedrockAgentCoreDeployer(this, 'NutritionAgent', nutritionAgentProps);

    // Deploy primary agent
    const petClinicAgentName = 'pet_clinic_agent'
    const primaryAgent = new BedrockAgentCoreDeployer(this, 'PrimaryAgent', {
      AgentName: petClinicAgentName,
      ImageUri: primaryAgentImage.imageUri,
      ExecutionRole: agentCoreRole.roleArn,
      Entrypoint: 'pet_clinic_agent.py',
      EnvironmentVariables: {
        NUTRITION_AGENT_ARN: nutritionAgent.agentArn,
        ...omniObservabilityEnv(petClinicAgentName)
      }
    });

    this.nutritionAgentImageUri = nutritionAgentImage.imageUri;
    this.primaryAgentImageUri = primaryAgentImage.imageUri;
    this.nutritionAgentArn = nutritionAgent.agentArn;
    this.primaryAgentArn = primaryAgent.agentArn;
  }
}

module.exports = { PetClinicAgentsStack };
