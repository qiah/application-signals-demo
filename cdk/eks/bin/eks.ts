#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { IAMStack } from '../lib/stacks/iam-stack';
import { EksStack } from '../lib/stacks/eks-stack';
import { RdsStack } from '../lib/stacks/rds-stack';
import { SyntheticCanaryStack } from '../lib/stacks/canary-stack';
import { CloudWatchRumStack } from "../lib/stacks/rum-stack";
import { KnowledgeBaseStack } from "../lib/stacks/knowledge-base-stack";
import { GuardrailStack } from "../lib/stacks/guardrail-stack";
import { ResourceExplorerStack } from "../lib/stacks/resource-explorer-stack";

const app = new App();

const networkStack = new NetworkStack(app, 'AppSignalsEksNetworkStack');
const iamStack = new IAMStack(app, 'AppSignalsEksIamStack');

const rdsStack = new RdsStack(app, 'AppSignalsEksRdsStack', {
  vpc: networkStack.vpc,
  rdsSecurityGroup: networkStack.rdsSecurityGroup,
})

rdsStack.addDependency(networkStack);

const rumStack = new CloudWatchRumStack(app, 'AppSignalsRumStack', {
  sampleAppNamespace: 'pet-clinic', // Using the same namespace as in EksStack
})

// Add Knowledge Base Stack for Application Signals documentation
const knowledgeBaseStack = new KnowledgeBaseStack(app, 'AppSignalsKnowledgeBaseStack')

// Add Guardrail Stack for Application Signals
const guardrailStack = new GuardrailStack(app, 'AppSignalsGuardrailStack')

// Add Resource Explorer Stack to enable AWS Resource Explorer
const resourceExplorerStack = new ResourceExplorerStack(app, 'AppSignalsResourceExplorerStack')

const eksStack = new EksStack(app, 'AppSignalsEksClusterStack', {
  vpc: networkStack.vpc,
  eksClusterRoleProp: iamStack.eksClusterRoleProp,
  eksNodeGroupRoleProp: iamStack.eksNodeGroupRoleProp,
  ebsCsiAddonRoleProp: iamStack.ebsCsiAddonRoleProp,
  sampleAppRoleProp: iamStack.sampleAppRoleProp,
  rdsClusterEndpoint: rdsStack.clusterEndpoint,
  rdsSecurityGroupId: networkStack.rdsSecurityGroupId,
  rumIdentityPoolId: rumStack.identityPoolId,
  rumAppMonitorId: rumStack.appMonitorId
});

eksStack.addDependency(networkStack);
eksStack.addDependency(iamStack);
eksStack.addDependency(rdsStack);
eksStack.addDependency(rumStack);
eksStack.addDependency(knowledgeBaseStack); // Add dependency on Knowledge Base Stack
eksStack.addDependency(guardrailStack); // Add dependency on Guardrail Stack
eksStack.addDependency(resourceExplorerStack); // Add dependency on resource explorer

const syntheticCanaryStack = new SyntheticCanaryStack(app, 'AppSignalsSyntheticCanaryStack', {
  vpc: networkStack.vpc,
  albEndpoint: eksStack.ingressExternalIp.value,
  syntheticCanaryRoleProp: iamStack.syntheticCanaryRoleProp,
})

syntheticCanaryStack.addDependency(rdsStack);
syntheticCanaryStack.addDependency(rumStack);
