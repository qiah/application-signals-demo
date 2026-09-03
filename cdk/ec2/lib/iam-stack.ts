import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Role, ServicePrincipal, ManagedPolicy, Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { CfnTelemetryRule } from 'aws-cdk-lib/aws-observabilityadmin';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId, Provider } from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class IAMStack extends cdk.Stack {
  // Expose the IAM Role for use in other stacks
  public readonly ec2InstanceRole: Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the IAM Role for EC2 instances
    this.ec2InstanceRole = new Role(this, 'EC2InstanceRole', {
      roleName: 'EC2InstanceRole', // Customize the role name if needed
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM Role for EC2 instances to access AWS services',
    });

    // Attach AWS managed policies to the role

    // Allow EC2 instances to communicate with AWS Systems Manager
    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
    // Omni guide > EC2 > "Grant permissions & provision the role": CloudWatchAgentServerPolicy
    // (metrics + logs) and AWSXRayDaemonWriteAccess (traces) on the instance role.
    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')
    );
    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );

    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSQSFullAccess')
    );

    // Allow access to RDS (consider using a custom policy for least privilege)
    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSFullAccess')
    );

    // Attach additional managed policies if required by the application
    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess')
    );

    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess')
    );

    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
    );

    this.ec2InstanceRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonKinesisFullAccess')
    );

    // Create a custom policy to allow access to the database secret in Secrets Manager
    const secretAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['arn:aws:secretsmanager:*:*:secret:PetClinicDBCredentials-*']
    });
    this.ec2InstanceRole.addToPolicy(secretAccessPolicy);

    // Omni guide > EC2 > "Enable EC2 host metrics with a telemetry rule" > CDK-TS case, with two
    // corrections the service forced (the guide's snippet is rejected as written):
    //  - allowFieldUpdates removed: only supported for AWS::EC2::VPC (API: "AllowFieldUpdates is not
    //    supported for resource type: AWS::EC2::Instance").
    //  - selectionCriteria uses the service grammar ResourceTags IN ({"TagKey":..,"TagValue":..});
    //    the guide's tags['omni:monitor'] == 'true' fails with "Invalid resource selection criteria".
    // Prerequisite the guide omits: telemetry evaluation must be enabled on the account first
    // (observabilityadmin StartTelemetryEvaluation), otherwise CREATE fails.

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
      policy: AwsCustomResourcePolicy.fromStatements([new PolicyStatement({ actions: ['logs:PutResourcePolicy'], resources: ['*'] })]),
    });
    const traceDestination = new AwsCustomResource(this, 'OmniTraceDestination', {
      onCreate: {
        service: 'xray', action: 'UpdateTraceSegmentDestination', parameters: { Destination: 'CloudWatchLogs' },
        physicalResourceId: PhysicalResourceId.of('omni-trace-destination'),
        ignoreErrorCodesMatching: 'InvalidRequestException|ConflictException',
      },
      installLatestAwsSdk: true,
      policy: AwsCustomResourcePolicy.fromStatements([new PolicyStatement({ actions: ['xray:UpdateTraceSegmentDestination', 'xray:GetTraceSegmentDestination', 'logs:PutRetentionPolicy', 'logs:CreateLogGroup', 'logs:DescribeLogGroups'], resources: ['*'] })]),
    });
    traceDestination.node.addDependency(spansPolicy);

    // Prerequisite the guide omits, automated: telemetry rules require ObservabilityAdmin telemetry evaluation to be
    // RUNNING on the account. StartTelemetryEvaluation is asynchronous and can land in FAILED_START on a first attempt
    // (observed), so a Provider-backed custom resource starts it, polls, and retries until RUNNING before the rule
    // is created. Skip the whole telemetry-rule feature with `cdk deploy -c telemetryRule=false`.
    const evaluationFn = new lambda.Function(this, 'OmniTelemetryEvaluationFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import boto3, logging
log = logging.getLogger(); log.setLevel(logging.INFO)
oa = boto3.client('observabilityadmin')

def _start():
    try:
        oa.start_telemetry_evaluation(); log.info('StartTelemetryEvaluation called')
    except Exception as e:
        log.warning('StartTelemetryEvaluation: %s', e)

def handler(event, context):
    # Provider framework: the same function serves onEvent and isComplete; both just check/advance the state.
    rt = event.get('RequestType')
    if rt == 'Delete':
        return {'PhysicalResourceId': 'omni-telemetry-evaluation', 'IsComplete': True}
    status = oa.get_telemetry_evaluation_status().get('Status')
    log.info('telemetry evaluation status: %s', status)
    if status == 'RUNNING':
        return {'PhysicalResourceId': 'omni-telemetry-evaluation', 'IsComplete': True}
    if status in ('NOT_STARTED', 'FAILED_START', 'STOPPED', None):
        _start()
    return {'PhysicalResourceId': 'omni-telemetry-evaluation', 'IsComplete': False}
`),
    });
    evaluationFn.addToRolePolicy(new PolicyStatement({
      actions: ['observabilityadmin:StartTelemetryEvaluation', 'observabilityadmin:GetTelemetryEvaluationStatus'], resources: ['*'],
    }));
    evaluationFn.addToRolePolicy(new PolicyStatement({ actions: ['iam:CreateServiceLinkedRole'], resources: ['*'] }));
    const evaluationProvider = new Provider(this, 'OmniTelemetryEvaluationProvider', {
      onEventHandler: evaluationFn,
      isCompleteHandler: evaluationFn,
      queryInterval: cdk.Duration.seconds(15),
      totalTimeout: cdk.Duration.minutes(10),
    });
    const telemetryEvaluation = new cdk.CustomResource(this, 'OmniTelemetryEvaluation', {
      serviceToken: evaluationProvider.serviceToken,
      resourceType: 'Custom::OmniTelemetryEvaluation',
    });

    if (this.node.tryGetContext('telemetryRule') !== 'false') {
    const telemetryRule = new CfnTelemetryRule(this, 'omniec2detailedmetrics', {
      ruleName: 'omni-ec2-detailed-metrics',
      rule: {
        resourceType: 'AWS::EC2::Instance',
        telemetryType: 'Metrics',
        selectionCriteria: 'ResourceTags IN ({"TagKey":"omni:monitor","TagValue":"true"})',
      },
    });
    telemetryRule.node.addDependency(telemetryEvaluation);
    }

    // Output the IAM Role ARN
    new cdk.CfnOutput(this, 'EC2InstanceRoleARN', {
      value: this.ec2InstanceRole.roleArn,
      description: 'IAM Role ARN for EC2 instances',
      exportName: 'EC2InstanceRoleARN',
    });
  }
}
