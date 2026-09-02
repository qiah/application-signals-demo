import { ApplicationTargetGroup } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Role } from 'aws-cdk-lib/aws-iam';
import { Secret as SmSecret } from 'aws-cdk-lib/aws-secretsmanager';
import {
    Cluster,
    Compatibility,
    ContainerDependencyCondition,
    ContainerImage,
    FargateService,
    HealthCheck,
    LogDrivers,
    NetworkMode,
    Protocol,
    Secret as EcsSecret,
    TaskDefinition,
} from 'aws-cdk-lib/aws-ecs';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';

import { ServiceDiscoveryStack } from './servicediscoveryStack';
import { LogStack } from './logStack';

interface EcsClusterStackProps extends StackProps {
    readonly vpc: Vpc;
    readonly securityGroups: SecurityGroup[];
    readonly ecsTaskRole: Role;
    readonly ecsTaskExecutionRole: Role;
    readonly serviceDiscoveryStack: ServiceDiscoveryStack;
    readonly logStack: LogStack;
    readonly dbSecret: SmSecret;
    readonly dbInstanceEndpointAddress: string;
    readonly loadBalancerDnsName: string;
    readonly loadBalancerTargetGroup: ApplicationTargetGroup;
}

interface CreateServiceProps {
    readonly serviceName: string;
    readonly taskDefinition: TaskDefinition;
}

interface ServerTaskDefinitionConfig {
    image: string;
    port: number;
    environmentArgs: {
        [key: string]: string;
    };
}

interface ServiceTaskDefinitionConfig extends ServerTaskDefinitionConfig {
    command?: string[];
    healthCheck?: HealthCheck;
}

export class EcsClusterStack extends Stack {
    public readonly cluster: Cluster;
    private readonly securityGroups: SecurityGroup[];
    private readonly ecsTaskRole: Role;
    private readonly ecsTaskExecutionRole: Role;
    private readonly ecrImagePrefix: string;
    private readonly serviceDiscoveryStack: ServiceDiscoveryStack;
    private readonly logStack: LogStack;
    private readonly dbSecret: SmSecret;
    private readonly dbInstanceEndpointAddress: string;
    private readonly CLUSTER_NAME = 'ecs-pet-clinic-demo';
    private readonly CONFIG_SERVER = 'pet-clinic-config-server';
    private readonly DISCOVERY_SERVER = 'pet-clinic-discovery-server';
    private readonly ADMIN_SERVER = 'pet-clinic-admin-server';
    private readonly API_GATEWAY = 'pet-clinic-api-gateway';
    private readonly VISITS_SERVICE = 'pet-clinic-visits-service';
    private readonly CUSTOMERS_SERVICE = 'pet-clinic-customers-service';
    private readonly VETS_SERVICE = 'pet-clinic-vets-service';

    constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
        super(scope, id, props);

        this.cluster = new Cluster(this, 'EcsCluster', {
            vpc: props.vpc,
            clusterName: this.CLUSTER_NAME,
        });

        this.ecrImagePrefix = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`; // retrive ECR image from the private repository
        this.dbSecret = props.dbSecret;
        this.dbInstanceEndpointAddress = props.dbInstanceEndpointAddress;
        this.securityGroups = props.securityGroups;
        this.ecsTaskRole = props.ecsTaskRole;
        this.ecsTaskExecutionRole = props.ecsTaskExecutionRole;
        this.serviceDiscoveryStack = props.serviceDiscoveryStack;
        this.logStack = props.logStack;

        // Create Config, Discovery and Admin servers
        this.createConfigServer();
        this.createDiscoveryServer();
        this.createAdminServer();

        // Create microservices
        this.runVetsService();
        this.runCustomersService();
        this.runVisitsService();
        this.runInsuranceService();
        this.runBillingService();

        // Create pet clinic frontend
        this.createPetClinicFrontend(props.loadBalancerDnsName, props.loadBalancerTargetGroup);

        // Generate traffic
        this.generateTraffic(props.loadBalancerDnsName);

        new CfnOutput(this, 'EcsClusterArn', { value: this.cluster.clusterArn });
    }

    createConfigServer() {
        const configServerConfig: ServerTaskDefinitionConfig = {
            image: 'spring-petclinic-config-server',
            port: 8888,
            environmentArgs: {},
        };
        const taskDefinition = this.createServerTaskDefinition(this.CONFIG_SERVER, configServerConfig);

        // Create ECS service
        this.createService({
            serviceName: this.CONFIG_SERVER,
            taskDefinition: taskDefinition,
        });
    }

    createDiscoveryServer() {
        const discoveryServerConfig: ServerTaskDefinitionConfig = {
            image: 'spring-petclinic-discovery-server',
            port: 8761,
            environmentArgs: {
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
            },
        };

        const taskDefinition = this.createServerTaskDefinition(this.DISCOVERY_SERVER, discoveryServerConfig);

        // Create ECS service
        this.createService({
            serviceName: this.DISCOVERY_SERVER,
            taskDefinition: taskDefinition,
        });
    }

    createAdminServer() {
        const adminServerConfig: ServerTaskDefinitionConfig = {
            image: 'spring-petclinic-admin-server',
            port: 9090,
            environmentArgs: {
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
                DISCOVERY_SERVER_URL: `http://${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8761/eureka`,
                ADMIN_IP: `${this.ADMIN_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
            },
        };

        const taskDefinition = this.createServerTaskDefinition(this.ADMIN_SERVER, adminServerConfig);

        // Create ECS service
        this.createService({
            serviceName: this.ADMIN_SERVER,
            taskDefinition: taskDefinition,
        });
    }

    createPetClinicFrontend(loadBalancerDNS: string, targetGroup: ApplicationTargetGroup) {
        const frontendConfig: ServiceTaskDefinitionConfig = {
            image: 'spring-petclinic-api-gateway',
            environmentArgs: {
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
                DISCOVERY_SERVER_URL: `http://${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8761/eureka`,
                API_GATEWAY_IP: loadBalancerDNS,
            },
            port: 8080,
        };

        const taskDefinition = this.createJavaTaskDefinition(this.API_GATEWAY, frontendConfig);

        const service = new FargateService(this, `${this.API_GATEWAY}-ecs-service`, {
            serviceName: this.API_GATEWAY,
            taskDefinition: taskDefinition,
            cluster: this.cluster,
            securityGroups: this.securityGroups,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
            assignPublicIp: false,
            desiredCount: 1,
            // The gateway takes ~170s to become ready (JVM + OTel agent + Spring + Eureka),
            // which exceeds the default ALB health-check grace and causes a replace loop.
            healthCheckGracePeriod: Duration.seconds(300),
        });

        // Add Application Load Balancer target group
        service.attachToApplicationTargetGroup(targetGroup);
    }

    runVetsService() {
        const vetsConfig: ServiceTaskDefinitionConfig = {
            image: 'spring-petclinic-vets-service',
            environmentArgs: {
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
                DISCOVERY_SERVER_URL: `http://${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8761/eureka`,
                VETS_SERVICE_IP: `${this.VETS_SERVICE}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
            },
            port: 8083,
        };

        const taskDefinition = this.createJavaTaskDefinition(this.VETS_SERVICE, vetsConfig);

        // Create ECS service
        this.createService({
            serviceName: this.VETS_SERVICE,
            taskDefinition: taskDefinition,
        });
    }

    runCustomersService() {
        const customersConfig: ServiceTaskDefinitionConfig = {
            image: 'spring-petclinic-customers-service',
            environmentArgs: {
                REGION_FROM_ECS: this.region,
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
                DISCOVERY_SERVER_URL: `http://${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8761/eureka`,
                CUSTOMER_SERVICE_IP: `${this.CUSTOMERS_SERVICE}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
            },
            port: 8081,
        };

        const taskDefinition = this.createJavaTaskDefinition(this.CUSTOMERS_SERVICE, customersConfig);

        // Create ECS service
        this.createService({
            serviceName: this.CUSTOMERS_SERVICE,
            taskDefinition: taskDefinition,
        });
    }

    runVisitsService() {
        const visitsConfig: ServiceTaskDefinitionConfig = {
            image: 'spring-petclinic-visits-service',
            environmentArgs: {
                REGION_FROM_ECS: this.region,
                CONFIG_SERVER_URL: `http://${this.CONFIG_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8888`,
                DISCOVERY_SERVER_URL: `http://${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}:8761/eureka`,
                VISITS_SERVICE_IP: `${this.VISITS_SERVICE}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
            },
            port: 8082,
        };

        const taskDefinition = this.createJavaTaskDefinition(this.VISITS_SERVICE, visitsConfig);

        // Create ECS service
        this.createService({
            serviceName: this.VISITS_SERVICE,
            taskDefinition: taskDefinition,
        });
    }

    runInsuranceService() {
        const INSURANCE_SERVICE = 'pet-clinic-insurance-service';

        const healthCheck: HealthCheck = {
            command: ['CMD-SHELL', 'curl -f http://localhost:8000/insurances/ || exit 1'],
            interval: Duration.seconds(60),
            timeout: Duration.seconds(10),
            retries: 5,
            startPeriod: Duration.seconds(3),
        };

        const insuranceConfig: ServiceTaskDefinitionConfig = {
            port: 8000,
            image: 'python-petclinic-insurance-service',
            environmentArgs: {
                INSURANCE_SERVICE_IP: `${INSURANCE_SERVICE}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
                DJANGO_SETTINGS_MODULE: 'pet_clinic_insurance_service.settings',
            },
            command: [
                'sh',
                '-c',
                'python manage.py migrate && python manage.py loaddata initial_data.json && python manage.py runserver 0.0.0.0:8000 --noreload',
            ],
            healthCheck: healthCheck,
        };

        const taskDefinition = this.createPythonTaskDefinition(INSURANCE_SERVICE, insuranceConfig);

        // Create ECS service
        this.createService({
            serviceName: INSURANCE_SERVICE,
            taskDefinition: taskDefinition,
        });
    }

    runBillingService() {
        const BILLING_SERVICE = 'pet-clinic-billing-service';

        const billingConfig: ServiceTaskDefinitionConfig = {
            port: 8800,
            image: 'python-petclinic-billing-service',
            environmentArgs: {
                REGION: this.region,
                DJANGO_SETTINGS_MODULE: 'pet_clinic_billing_service.settings',
                BILLING_SERVICE_IP: `${BILLING_SERVICE}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
            },
            command: ['sh', '-c', 'python manage.py migrate && python manage.py runserver 0.0.0.0:8800 --noreload'],
        };

        const taskDefinition = this.createPythonTaskDefinition(BILLING_SERVICE, billingConfig);

        // Create ECS service
        this.createService({
            serviceName: BILLING_SERVICE,
            taskDefinition: taskDefinition,
        });
    }

    generateTraffic(loadBalancerDNS: string) {
        const TRAFFIC_GENERATOR = 'traffic-generator';
        const trafficGeneratorLogGroup = this.logStack.createLogGroup(TRAFFIC_GENERATOR);

        // Create ECS task definition
        const taskDefinition = new TaskDefinition(this, `${TRAFFIC_GENERATOR}-task`, {
            cpu: '256',
            memoryMiB: '512',
            compatibility: Compatibility.FARGATE,
            family: TRAFFIC_GENERATOR,
            networkMode: NetworkMode.AWS_VPC,
            taskRole: this.ecsTaskRole,
            executionRole: this.ecsTaskExecutionRole,
        });

        // Add Container to Task Definition
        taskDefinition.addContainer(`${TRAFFIC_GENERATOR}-container`, {
            image: ContainerImage.fromRegistry(`${this.ecrImagePrefix}/traffic-generator`),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            environment: {
                URL: `http://${loadBalancerDNS}:80`,
                HIGH_LOAD_MAX: '1600',
                HIGH_LOAD_MIN: '800',
                BURST_DELAY_MAX: '80',
                BURST_DELAY_MIN: '60',
                LOW_LOAD_MAX: '60',
                LOW_LOAD_MIN: '30',
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup: trafficGeneratorLogGroup,
            }),
        });

        new FargateService(this, `${TRAFFIC_GENERATOR}-ecs-service`, {
            serviceName: TRAFFIC_GENERATOR,
            taskDefinition: taskDefinition,
            cluster: this.cluster,
            securityGroups: this.securityGroups,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
            assignPublicIp: false,
            desiredCount: 1,
        });
    }

    // Omni ECS instrumentation: add the CloudWatch agent as a sidecar in the task, per the guide's
    // "Deploy the collector (Fargate sidecar)" step. The app exports OTLP to localhost (awsvpc shares
    // the network namespace) and the agent forwards to the CloudWatch OTLP endpoints. The app
    // container must depend on the agent with condition START (the agent image has no healthcheck,
    // so HEALTHY would hang startup).
    private readonly OTEL_ENV: Record<string, string> = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=pet-clinic',
    };

    addCloudWatchAgentSidecar(taskDefinition: TaskDefinition, serviceName: string, mainContainer: any) {
        const agent = taskDefinition.addContainer(`${serviceName}-cwagent`, {
            image: ContainerImage.fromRegistry('public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest'),
            essential: false,
            environment: {
                // Doc step 5, verbatim: empty otlp object.
                CW_CONFIG_CONTENT: JSON.stringify({ opentelemetry: { collect: { otlp: {} } } }),
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'cwagent',
                logGroup: this.logStack.createLogGroup(`${serviceName}-cwagent`),
            }),
        });
        mainContainer.addContainerDependencies({
            container: agent,
            condition: ContainerDependencyCondition.START,
        });
    }

    createJavaTaskDefinition(serviceName: string, config: ServiceTaskDefinitionConfig) {
        const { image, environmentArgs, port } = config;

        const logGroup = this.logStack.createLogGroup(serviceName);

        const taskDefinition = new TaskDefinition(this, `${serviceName}-task`, {
            cpu: '256',
            memoryMiB: '512',
            compatibility: Compatibility.FARGATE,
            family: serviceName,
            networkMode: NetworkMode.AWS_VPC,
            taskRole: this.ecsTaskRole,
            executionRole: this.ecsTaskExecutionRole,
        });

        // Add Container to Task Definition
        const mainContainer = taskDefinition.addContainer(`${serviceName}-container`, {
            image: ContainerImage.fromRegistry(`${this.ecrImagePrefix}/springcommunity/${image}`),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            environment: {
                SPRING_PROFILES_ACTIVE: 'ecs',
                OTEL_SERVICE_NAME: serviceName,
                // Attach the OTel Java agent (baked into the image) without editing the entrypoint.
                // Also force Reactor Netty onto NIO: the native epoll transport in Netty 4.1.76 spins on
                // "epoll_wait(..) failed: Function not implemented" on current 5.10 kernels and stalls requests.
                JAVA_TOOL_OPTIONS: '-javaagent:/application/opentelemetry-javaagent.jar -Dreactor.netty.native=false -Dio.netty.transport.noNative=true',
                ...this.OTEL_ENV,
                ...environmentArgs,
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup: logGroup,
            }),
        });

        // Add Port Mapping
        mainContainer.addPortMappings({
            containerPort: port,
            protocol: Protocol.TCP,
        });

        this.addCloudWatchAgentSidecar(taskDefinition, serviceName, mainContainer);

        return taskDefinition;
    }

    createPythonTaskDefinition(serviceName: string, config: ServiceTaskDefinitionConfig) {
        const { image, environmentArgs, port, command, healthCheck } = config;

        const logGroup = this.logStack.createLogGroup(serviceName);

        const taskDefinition = new TaskDefinition(this, `${serviceName}-task`, {
            cpu: '256',
            memoryMiB: '512',
            compatibility: Compatibility.FARGATE,
            family: serviceName,
            networkMode: NetworkMode.AWS_VPC,
            taskRole: this.ecsTaskRole,
            executionRole: this.ecsTaskExecutionRole,
        });

        // Add Container to Task Definition
        const mainContainer = taskDefinition.addContainer(`${serviceName}-container`, {
            image: ContainerImage.fromRegistry(`${this.ecrImagePrefix}/${image}`),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            secrets: {
                DB_USER: EcsSecret.fromSecretsManager(this.dbSecret, 'username'),
                DB_USER_PASSWORD: EcsSecret.fromSecretsManager(this.dbSecret, 'password'),
            },
            environment: {
                PYTHONPATH: '/app',
                EUREKA_SERVER_URL: `${this.DISCOVERY_SERVER}-DNS.${this.serviceDiscoveryStack.namespace.namespaceName}`,
                DB_NAME: 'postgres',
                DATABASE_PROFILE: 'postgresql',
                DB_SERVICE_HOST: this.dbInstanceEndpointAddress,
                DB_SERVICE_PORT: '5432',
                OTEL_SERVICE_NAME: serviceName,
                OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED: 'true',
                ...this.OTEL_ENV,
                ...environmentArgs,
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup: logGroup,
            }),
            // Run the app under the OTel Python auto-instrumentation launcher (the distro is baked
            // into the image). Only the runserver invocation is wrapped, not migrate/loaddata.
            command: command
                ? command.map((c) =>
                      c.replace(/(python manage\.py runserver)/g, 'opentelemetry-instrument $1'),
                  )
                : command,
            healthCheck,
        });

        // Add Port Mapping
        mainContainer.addPortMappings({
            containerPort: port,
            protocol: Protocol.TCP,
        });

        this.addCloudWatchAgentSidecar(taskDefinition, serviceName, mainContainer);

        return taskDefinition;
    }

    createService(props: CreateServiceProps) {
        // 1. create service discovery service
        const DNSService = this.serviceDiscoveryStack.createService(props.serviceName);

        // 2, create ECS service
        const ecsService = new FargateService(this, `${props.serviceName}-ecs-service`, {
            serviceName: props.serviceName,
            taskDefinition: props.taskDefinition,
            cluster: this.cluster,
            securityGroups: this.securityGroups,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
            assignPublicIp: false,
        });

        ecsService.associateCloudMapService({
            service: DNSService,
        });

        new CfnOutput(this, `ecsService-${props.serviceName}`, {
            value: ecsService.serviceName,
        });
        console.log(`Ecs Service - ${props.serviceName} is created`);
    }

    createServerTaskDefinition(serverName: string, config: ServerTaskDefinitionConfig) {
        const { image, port, environmentArgs } = config;

        const logGroup = this.logStack.createLogGroup(serverName);
        const taskDefinition = new TaskDefinition(this, `${serverName}-task`, {
            cpu: '256',
            memoryMiB: '512',
            compatibility: Compatibility.FARGATE,
            family: serverName,
            networkMode: NetworkMode.AWS_VPC,
            taskRole: this.ecsTaskRole,
            executionRole: this.ecsTaskExecutionRole,
        });

        // Add Container to Task Definition
        const container = taskDefinition.addContainer(`${serverName}-container`, {
            image: ContainerImage.fromRegistry(`${this.ecrImagePrefix}/springcommunity/${image}`),
            cpu: 256,
            memoryLimitMiB: 512,
            essential: true,
            environment: {
                SPRING_PROFILES_ACTIVE: 'ecs',
                ...environmentArgs,
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logGroup: logGroup,
            }),
        });

        container.addPortMappings({
            containerPort: port,
            protocol: Protocol.TCP,
        });

        return taskDefinition;
    }
}
