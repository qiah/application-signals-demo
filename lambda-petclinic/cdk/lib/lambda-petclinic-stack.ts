import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { LambdaVersioning } from './lambda-version-resource';

export class LambdaPetClinicStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const table = new dynamodb.Table(this, 'HistoricalRecordTable', {
      tableName: 'HistoricalRecordDynamoDBTable',
      partitionKey: { name: 'recordId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For easier cleanup in demo environments
    });

    // IAM Role for Lambda Functions
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: 'lambda_exec_role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Add wildcard policy for demo purposes (equivalent to the Terraform configuration)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['*'],
      resources: ['*'],
      effect: iam.Effect.ALLOW,
    }));

    const regionName = this.region;

    // Define the bundle options for Python Lambda functions
    const pythonBundlingOptions = {
      image: lambda.Runtime.PYTHON_3_13.bundlingImage,
      command: [
        'bash', '-c', [
          'pip install -r requirements.txt -t /asset-output',
          'cp lambda_function.py /asset-output'
        ].join(' && ')
      ],
    };

    // Lambda Function 1: Create Appointment
    const createLambda = new lambda.Function(this, 'CreateAppointmentFunction', {
      functionName: 'appointment-service-create',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../sample-apps/function'), {
        bundling: pythonBundlingOptions
      }),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });
    // Add tags to Lambda function
    cdk.Tags.of(createLambda).add('Team', 'WorkflowTeam');
    cdk.Tags.of(createLambda).add('Application', 'Appointment');
    cdk.Tags.of(createLambda).add('Tier', 'Tier-3');

    // Lambda Function 2: List Appointments
    const listLambda = new lambda.Function(this, 'ListAppointmentsFunction', {
      functionName: 'appointment-service-list',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../sample-apps/function2'), {
        bundling: pythonBundlingOptions
      }),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });
    // Add tags to Lambda function
    cdk.Tags.of(listLambda).add('Team', 'WorkflowTeam');
    cdk.Tags.of(listLambda).add('Application', 'Appointment');
    cdk.Tags.of(listLambda).add('Tier', 'Tier-3');

    // Lambda Function 3: Get Appointment
    const getLambda = new lambda.Function(this, 'GetAppointmentFunction', {
      functionName: 'appointment-service-get',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../sample-apps/function3'), {
        bundling: pythonBundlingOptions
      }),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      environment: {
        VERSION: 'v1-original',
      },
    });
    // Add tags to Lambda function
    cdk.Tags.of(getLambda).add('Team', 'WorkflowTeam');
    cdk.Tags.of(getLambda).add('Application', 'Appointment');
    cdk.Tags.of(getLambda).add('Tier', 'Tier-3');
    
    // Create the alternate version code as a ZIP asset
    const alternateCodeAsset = new s3assets.Asset(this, 'AlternateCodeAsset', {
      path: path.join(__dirname, '../../sample-apps/function3-different-version'),
      bundling: {
        image: lambda.Runtime.PYTHON_3_13.bundlingImage,
        command: [
          'bash', '-c', [
            'pip install -r requirements.txt -t /tmp/package',
            'cp lambda_function.py /tmp/package/',
            'cd /tmp/package',
            'zip -r /asset-output/function.zip .'
          ].join(' && ')
        ],
        outputType: cdk.BundlingOutput.SINGLE_FILE, // This ensures the ZIP file is preserved as-is
      }
    });
    
    // API Gateway
    const api = new apigateway.RestApi(this, 'AppointmentServiceAPI', {
      restApiName: 'appointment-service-gateway',
      description: 'API Gateway for Lambda function',
      deployOptions: {
        stageName: 'prod',
      },
    });
    // Add tags to API Gateway
    cdk.Tags.of(api).add('Team', 'WorkflowTeam');
    cdk.Tags.of(api).add('Application', 'Appointment');
    cdk.Tags.of(api).add('Tier', 'Tier-3');
    // API Gateway Resource for /add
    const addResource = api.root.addResource('add');
    addResource.addMethod('GET', new apigateway.LambdaIntegration(createLambda));

    // API Gateway Resource for /list
    const listResource = api.root.addResource('list');
    listResource.addMethod('GET', new apigateway.LambdaIntegration(listLambda));

    // API Gateway Resource for /get - Using Lambda function with alias
    const getResource = api.root.addResource('get');
    
    // Create Lambda versioning with our custom resource
    const lambdaVersioning = new LambdaVersioning(this, 'GetAppointmentVersioning', {
      lambdaFunction: getLambda,
      alternateCodePath: `${alternateCodeAsset.s3BucketName}/${alternateCodeAsset.s3ObjectKey}`,
      alternateVersionWeight: 0.5, // 50% traffic to the alternate version
      aliasName: 'prod',
    });

    // Create a Lambda integration with the function alias using constructed ARN
    const aliasArn = `${getLambda.functionArn}:prod`;
    const aliasIntegration = new apigateway.LambdaIntegration(
      lambda.Function.fromFunctionAttributes(this, 'GetAppointmentAlias', {
        functionArn: aliasArn,
        sameEnvironment: true,
      })
    );
    
    const getMethod = getResource.addMethod('GET', aliasIntegration);
    
    // Ensure the method depends on the versioning resource
    getMethod.node.addDependency(lambdaVersioning);

    // Lambda Function 4: HTTP Requester
    const httpRequesterLambda = new lambda.Function(this, 'HttpRequesterFunction', {
      functionName: 'HttpRequesterFunction',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../sample-apps/function4'), {
        bundling: pythonBundlingOptions
      }),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(70),
      environment: {
        API_URL_1: `${api.deploymentStage.urlForPath('/add')}?owners=lw&petid=dog&recordId=1`,
        API_URL_2: `${api.deploymentStage.urlForPath('/list')}?owners=lw&petid=dog`,
        API_URL_3: `${api.deploymentStage.urlForPath('/get')}?owners=lw&petid=dog&recordId=1`,
      },
    });

    // EventBridge Rule to trigger HTTP Requester
    const rule = new events.Rule(this, 'HttpRequesterSchedule', {
      ruleName: 'TriggerHttpRequesterEveryMinute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });
    
    rule.addTarget(new targets.LambdaFunction(httpRequesterLambda));

    // Outputs
    new cdk.CfnOutput(this, 'ApiAddRecord', {
      value: `${api.deploymentStage.urlForPath('/add')}?owners=lw&petid=dog&recordId=1`,
    });

    new cdk.CfnOutput(this, 'ApiListRecord', {
      value: `${api.deploymentStage.urlForPath('/list')}?owners=lw&petid=dog`,
    });

    new cdk.CfnOutput(this, 'ApiQueryRecord', {
      value: `${api.deploymentStage.urlForPath('/get')}?owners=lw&petid=dog&recordId=1`,
    });

    new cdk.CfnOutput(this, 'LambdaVersionInfo', {
      value: `Traffic is split 50/50 between two versions of ${getLambda.functionName} function`,
    });

    // Output the region and layer ARN for debugging
    new cdk.CfnOutput(this, 'DeploymentRegion', {
      value: regionName,
      description: 'The AWS region where this stack is deployed',
    });
  }
}