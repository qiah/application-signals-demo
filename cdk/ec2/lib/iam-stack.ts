import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Role, ServicePrincipal, ManagedPolicy, Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { CfnTelemetryRule } from 'aws-cdk-lib/aws-observabilityadmin';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';

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
    // Prerequisite the guide omits, automated: telemetry rules require telemetry evaluation to be enabled on the
    // account (observabilityadmin:StartTelemetryEvaluation). Idempotent; CREATE fails without it.
    const telemetryEvaluation = new AwsCustomResource(this, 'OmniTelemetryEvaluation', {
      onCreate: {
        service: 'observabilityadmin',
        action: 'StartTelemetryEvaluation',
        parameters: {},
        physicalResourceId: PhysicalResourceId.of('omni-telemetry-evaluation'),
        ignoreErrorCodesMatching: 'ConflictException|ValidationException',
      },
      installLatestAwsSdk: true,
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({ actions: ['observabilityadmin:StartTelemetryEvaluation', 'observabilityadmin:GetTelemetryEvaluationStatus'], resources: ['*'] }),
        new PolicyStatement({ actions: ['iam:CreateServiceLinkedRole'], resources: ['*'] }),
      ]),
    });

    const telemetryRule = new CfnTelemetryRule(this, 'omniec2detailedmetrics', {
      ruleName: 'omni-ec2-detailed-metrics',
      rule: {
        resourceType: 'AWS::EC2::Instance',
        telemetryType: 'Metrics',
        selectionCriteria: 'ResourceTags IN ({"TagKey":"omni:monitor","TagValue":"true"})',
      },
    });
    telemetryRule.node.addDependency(telemetryEvaluation);

    // Output the IAM Role ARN
    new cdk.CfnOutput(this, 'EC2InstanceRoleARN', {
      value: this.ec2InstanceRole.roleArn,
      description: 'IAM Role ARN for EC2 instances',
      exportName: 'EC2InstanceRoleARN',
    });
  }
}
