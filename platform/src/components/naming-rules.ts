import { Output, output } from "@pulumi/pulumi";

/**
 * How SST names each resource type that its components create: which arg
 * holds the physical name, and how long that name may be.
 *
 * A type a built-in component uses has to be in one of the two lists here.
 * Add types used by your own components with `sst.Component.naming()`.
 */
export type BuiltInNamingRule = [
  field: string,
  max: number,
  options?: {
    lower?: boolean;
    replace?: (name: string) => string;
    suffix?: (props: any) => Output<string>;
  },
];

/**
 * How a resource type gets its physical name: which arg holds the name and
 * how long it may be. `false` leaves the name to the provider.
 */
export type NamingRule =
  | false
  | {
      field: string;
      max: number;
      lower?: boolean;
      replace?: (name: string) => string;
    };

/** Types whose physical name SST doesn't set. */
export const UNPREFIXED_TYPES = new Set<string>([
  // resources manually named
  "aws:cloudwatch/logGroup:LogGroup",
  "aws:ecs/service:Service",
  "aws:ecs/taskDefinition:TaskDefinition",
  "aws:lb/targetGroup:TargetGroup",
  "aws:servicediscovery/privateDnsNamespace:PrivateDnsNamespace",
  "aws:servicediscovery/service:Service",
  // resources not prefixed
  "pulumi-nodejs:dynamic:Resource",
  "random:index/randomId:RandomId",
  "random:index/randomPassword:RandomPassword",
  "command:local:Command",
  "tls:index/privateKey:PrivateKey",
  "aws:acm/certificate:Certificate",
  "aws:acm/certificateValidation:CertificateValidation",
  "aws:apigateway/basePathMapping:BasePathMapping",
  "aws:apigateway/deployment:Deployment",
  "aws:apigateway/domainName:DomainName",
  "aws:apigateway/integration:Integration",
  "aws:apigateway/integrationResponse:IntegrationResponse",
  "aws:apigateway/method:Method",
  "aws:apigateway/methodResponse:MethodResponse",
  "aws:apigateway/resource:Resource",
  "aws:apigateway/response:Response",
  "aws:apigateway/stage:Stage",
  "aws:apigateway/usagePlanKey:UsagePlanKey",
  "aws:apigatewayv2/apiMapping:ApiMapping",
  "aws:apigatewayv2/domainName:DomainName",
  "aws:apigatewayv2/integration:Integration",
  "aws:apigatewayv2/route:Route",
  "aws:apigatewayv2/stage:Stage",
  "aws:appautoscaling/target:Target",
  "aws:appsync/dataSource:DataSource",
  "aws:appsync/domainName:DomainName",
  "aws:appsync/domainNameApiAssociation:DomainNameApiAssociation",
  "aws:appsync/function:Function",
  "aws:appsync/resolver:Resolver",
  "aws:ec2/routeTableAssociation:RouteTableAssociation",
  "aws:ec2/eipAssociation:EipAssociation",
  "aws:ecs/clusterCapacityProviders:ClusterCapacityProviders",
  "aws:efs/fileSystem:FileSystem",
  "aws:efs/mountTarget:MountTarget",
  "aws:efs/accessPoint:AccessPoint",
  "aws:iam/accessKey:AccessKey",
  "aws:iam/instanceProfile:InstanceProfile",
  "aws:iam/policy:Policy",
  "aws:iam/userPolicy:UserPolicy",
  "aws:cloudfront/cachePolicy:CachePolicy",
  "aws:cloudfront/distribution:Distribution",
  "aws:cognito/identityPoolRoleAttachment:IdentityPoolRoleAttachment",
  "aws:cognito/identityProvider:IdentityProvider",
  "aws:cognito/userPoolClient:UserPoolClient",
  "aws:lambda/alias:Alias",
  "aws:lambda/eventSourceMapping:EventSourceMapping",
  "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
  "aws:lambda/functionUrl:FunctionUrl",
  "aws:lambda/invocation:Invocation",
  "aws:lambda/permission:Permission",
  "aws:lambda/provisionedConcurrencyConfig:ProvisionedConcurrencyConfig",
  "aws:lb/listener:Listener",
  "aws:lb/listenerRule:ListenerRule",
  "aws:opensearch/domainPolicy:DomainPolicy",
  "aws:rds/proxyDefaultTargetGroup:ProxyDefaultTargetGroup",
  "aws:rds/proxyTarget:ProxyTarget",
  "aws:route53/record:Record",
  "aws:s3/bucketCorsConfigurationV2:BucketCorsConfigurationV2",
  "aws:s3/bucketCorsConfiguration:BucketCorsConfiguration",
  "aws:s3/bucketNotification:BucketNotification",
  "aws:s3/bucketObject:BucketObject",
  "aws:s3/bucketObjectv2:BucketObjectv2",
  "aws:s3/bucketPolicy:BucketPolicy",
  "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock",
  "aws:s3/bucketVersioningV2:BucketVersioningV2",
  "aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2",
  "aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration",
  "aws:s3/bucketWebsiteConfigurationV2:BucketWebsiteConfigurationV2",
  "aws:s3/bucketVersioning:BucketVersioning",
  "aws:s3/bucketWebsiteConfiguration:BucketWebsiteConfiguration",
  "aws:secretsmanager/secretVersion:SecretVersion",
  "aws:wafv2/webAclLoggingConfiguration:WebAclLoggingConfiguration",
  "aws:ses/domainIdentityVerification:DomainIdentityVerification",
  "aws:sesv2/configurationSetEventDestination:ConfigurationSetEventDestination",
  "aws:sesv2/emailIdentity:EmailIdentity",
  "aws:sesv2/emailIdentityMailFromAttributes:EmailIdentityMailFromAttributes",
  "aws:sns/topicPolicy:TopicPolicy",
  "aws:sns/topicSubscription:TopicSubscription",
  "aws:sqs/queuePolicy:QueuePolicy",
  "aws:ssm/parameter:Parameter",
  "cloudflare:index/dnsRecord:DnsRecord",
  "cloudflare:index/pageRule:PageRule",
  "cloudflare:index/workersCronTrigger:WorkersCronTrigger",
  "cloudflare:index/workersCustomDomain:WorkersCustomDomain",
  "cloudflare:index/queueConsumer:QueueConsumer",
  "docker-build:index:Image",
  "vercel:index/dnsRecord:DnsRecord",
  "aws:dsql/clusterPeering:ClusterPeering",
]);

/** Types whose physical name is prefixed with the app and stage. */
export const NAMING_RULES: Record<string, BuiltInNamingRule> = {
  "aws:apigateway/apiKey:ApiKey": ["name", 1024],
  "aws:apigateway/authorizer:Authorizer": ["name", 128],
  "aws:apigateway/restApi:RestApi": ["name", 128],
  "aws:apigateway/usagePlan:UsagePlan": ["name", 65536], // no length limit
  "aws:apigatewayv2/api:Api": ["name", 128],
  "aws:apigatewayv2/authorizer:Authorizer": ["name", 128],
  "aws:apigatewayv2/vpcLink:VpcLink": ["name", 128],
  "aws:appautoscaling/policy:Policy": ["name", 255],
  "aws:appsync/graphQLApi:GraphQLApi": ["name", 65536],
  "aws:cloudwatch/eventBus:EventBus": ["name", 256],
  "aws:cloudwatch/eventTarget:EventTarget": ["targetId", 64],
  "aws:cloudwatch/eventRule:EventRule": ["name", 64],
  "aws:cloudfront/function:Function": ["name", 64],
  "aws:cloudfront/keyValueStore:KeyValueStore": ["name", 64],
  "aws:cognito/identityPool:IdentityPool": ["identityPoolName", 128],
  "aws:cognito/userPool:UserPool": ["name", 128],
  "aws:cognito/userPoolDomain:UserPoolDomain": [
    "domain",
    63,
    { lower: true },
  ],
  "aws:dynamodb/table:Table": ["name", 255],
  "aws:dsql/cluster:Cluster": ["tags", 255],
  "aws:ec2/keyPair:KeyPair": ["keyName", 255],
  "aws:ec2/eip:Eip": ["tags", 255],
  "aws:ec2/instance:Instance": ["tags", 255],
  "aws:ec2/internetGateway:InternetGateway": ["tags", 255],
  "aws:ec2/natGateway:NatGateway": ["tags", 255],
  "aws:ec2/routeTable:RouteTable": ["tags", 255],
  "aws:ec2/securityGroup:SecurityGroup": ["tags", 255],
  "aws:ec2/defaultSecurityGroup:DefaultSecurityGroup": ["tags", 255],
  "aws:ec2/subnet:Subnet": ["tags", 255],
  "aws:ec2/vpc:Vpc": ["tags", 255],
  "aws:ec2/vpcEndpoint:VpcEndpoint": ["tags", 255],
  "aws:ecs/cluster:Cluster": ["name", 255],
  "aws:elasticache/parameterGroup:ParameterGroup": [
    "name",
    255,
    { lower: true },
  ],
  "aws:elasticache/replicationGroup:ReplicationGroup": [
    "replicationGroupId",
    40,
    { lower: true, replace: (name) => name.replaceAll(/-+/g, "-") },
  ],
  "aws:elasticache/subnetGroup:SubnetGroup": [
    "name",
    255,
    { lower: true },
  ],
  "aws:iam/role:Role": ["name", 64],
  "aws:iam/user:User": ["name", 64],
  "aws:iot/authorizer:Authorizer": ["name", 128],
  "aws:iot/topicRule:TopicRule": [
    "name",
    128,
    { replace: (name) => name.replaceAll("-", "_") },
  ],
  "aws:kinesis/stream:Stream": ["name", 255],
  // AWS Load Balancer name allows 32 chars, but an 8 char suffix
  // ie. "-1234567" is automatically added
  "aws:lb/loadBalancer:LoadBalancer": ["name", 24],
  "aws:lambda/function:Function": ["name", 64],
  "aws:opensearch/domain:Domain": ["domainName", 28, { lower: true }],
  "aws:rds/cluster:Cluster": [
    "clusterIdentifier",
    63,
    { lower: true },
  ],
  "aws:rds/clusterInstance:ClusterInstance": [
    "identifier",
    63,
    { lower: true },
  ],
  "aws:rds/instance:Instance": ["identifier", 63, { lower: true }],
  "aws:rds/proxy:Proxy": ["name", 60, { lower: true }],
  "aws:rds/clusterParameterGroup:ClusterParameterGroup": [
    "name",
    255,
    { lower: true },
  ],
  "aws:rds/parameterGroup:ParameterGroup": [
    "name",
    255,
    { lower: true },
  ],
  "aws:rds/subnetGroup:SubnetGroup": ["name", 255, { lower: true }],
  "aws:s3/bucket:Bucket": ["bucket", 63, { lower: true }],
  "aws:secretsmanager/secret:Secret": ["name", 512],
  "aws:sesv2/configurationSet:ConfigurationSet": [
    "configurationSetName",
    64,
    { lower: true },
  ],
  "aws:scheduler/schedule:Schedule": ["name", 64],
  "aws:sfn/stateMachine:StateMachine": ["name", 80],
  "aws:sns/topic:Topic": [
    "name",
    256,
    {
      suffix: (props) =>
        output(props.fifoTopic).apply((fifo) =>
          fifo ? ".fifo" : "",
        ),
    },
  ],
  "aws:sqs/queue:Queue": [
    "name",
    80,
    {
      suffix: (props) =>
        output(props.fifoQueue).apply((fifo) =>
          fifo ? ".fifo" : "",
        ),
    },
  ],
  "aws:wafv2/webAcl:WebAcl": ["name", 64],
  "cloudflare:index/d1Database:D1Database": [
    "name",
    64,
    { lower: true },
  ],
  "cloudflare:index/r2Bucket:R2Bucket": ["name", 64, { lower: true }],
  "aws:backup/vault:Vault": ["name", 50],
  "aws:backup/plan:Plan": ["name", 50],
  "aws:backup/selection:Selection": ["name", 50],
  "cloudflare:index/workersScript:WorkersScript": [
    "scriptName",
    64,
    { lower: true },
  ],
  "cloudflare:index/queue:Queue": ["queueName", 64, { lower: true }],
  "cloudflare:index/workersKvNamespace:WorkersKvNamespace": [
    "title",
    64,
    { lower: true },
  ],
  "cloudflare:index/hyperdriveConfig:HyperdriveConfig": [
    "name",
    64,
    { lower: true },
  ],
  "cloudflare:index/workflow:Workflow": [
    "workflowName",
    64,
    { lower: true },
  ],
};
