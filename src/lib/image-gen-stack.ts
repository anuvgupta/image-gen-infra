// image-gen.stack.ts

import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as path from "path";
import { Construct } from "constructs";

import { calculateTPS, TPSCalculationParams } from "../util/tps";

interface ImageGenStackProps extends cdk.StackProps {
    stageName: string;
    domainName: string;
    apiDomainName: string;
    runpodsApiKey: string;
    runpodsEndpoint: string;
    awsOutputBucketPrefix: string;
    awsWebsiteBucketPrefix: string;
    throttlingConfig: TPSCalculationParams;
    devWebsiteUsername?: string;
    devWebsitePassword?: string;
}

export class ImageGenStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ImageGenStackProps) {
        super(scope, id, props);

        /* SSL CERTIFICATES - CUSTOM DOMAINS */
        // Create SSL certificate for the domain
        const websiteCertificate = new acm.Certificate(this, "Certificate", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(),
        });
        const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
            domainName: props.apiDomainName,
            validation: acm.CertificateValidation.fromDns(),
        });

        /* S3 BUCKETS - WEBSITE BUCKET */
        // Website bucket for static files
        const websiteBucket = new s3.Bucket(this, "ImageGenWebsiteBucket", {
            bucketName: `${props.awsWebsiteBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        });

        /* S3 BUCKETS - OUTPUT BUCKET */
        // Output bucket for generated images
        const outputBucket = new s3.Bucket(this, "ImageGenOutputBucket", {
            bucketName: `${props.awsOutputBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            lifecycleRules: [
                {
                    // Create strict bucket TTL policy
                    // RunPods requests disappear after 30 min, so we can't query them from /status
                    // endpoint after 30 min. So the CDN cache & bucket TTL determine how long the
                    // image persists past 30 min. We can be strict and only allow the image to be
                    // accessible for 24-30 hours (24 min, 30 max) via 6 hour cache & 1 day bucket TTL.
                    // See CloudFront section below.
                    expiration: cdk.Duration.days(1),
                    id: "DeleteAfterOneDay",
                },
            ],
        });
        // IAM user for uploading to output bucket
        const uploadUser = new iam.User(this, "ImageUploadUser");
        // Create access key and store in Secrets Manager
        const accessKey = new iam.AccessKey(this, "ImageUploadUserAccessKey", {
            user: uploadUser,
        });
        const uploadCredentialsSecret = new secretsmanager.Secret(
            this,
            "UploadCredentials",
            {
                description: `AWS credentials for image gen worker's upload access in ${props.stageName}`,
                secretObjectValue: {
                    accessKeyId: cdk.SecretValue.unsafePlainText(
                        accessKey.accessKeyId
                    ),
                    secretAccessKey: accessKey.secretAccessKey,
                },
            }
        );
        // Grant upload permissions
        outputBucket.grantWrite(uploadUser);

        /* CLOUDFRONT CDN - ORIGINS */
        // CloudFront distribution origins & access identities
        const websiteOrigin = new origins.S3Origin(websiteBucket, {
            originAccessIdentity: new cloudfront.OriginAccessIdentity(
                this,
                `WebsiteBucketOAI`,
                {
                    comment: `OAI for CloudFront -> S3 Bucket ${websiteBucket.bucketName}`,
                }
            ),
        });
        const outputOrigin = new origins.S3Origin(outputBucket, {
            originPath: "",
            originAccessIdentity: new cloudfront.OriginAccessIdentity(
                this,
                `OutputBucketOAI`,
                {
                    comment: `OAI for CloudFront -> S3 Bucket ${outputBucket.bucketName}`,
                }
            ),
        });

        /* CLOUDFRONT CDN - DEV ENVIRONMENT ACCESS */
        // Create CloudFront Function for basic auth when in dev stage
        let basicAuthFunction: cloudfront.Function | undefined;
        let basicAuthFunctionAssociation: {} | undefined;
        if (props.stageName === "dev") {
            // Base64 encode the credentials
            const credentials = Buffer.from(
                `${props.devWebsiteUsername}:${props.devWebsitePassword}`
            ).toString("base64");

            basicAuthFunction = new cloudfront.Function(
                this,
                `BasicAuthFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                    function handler(event) {
                        var request = event.request;
                        var headers = request.headers;
                        
                        // Check for Basic auth header
                        if (!headers.authorization) {
                            return {
                                statusCode: 401,
                                statusDescription: 'Unauthorized',
                                headers: {
                                    'www-authenticate': { value: 'Basic' }
                                }
                            };
                        }

                        // Verify credentials
                        var authHeader = headers.authorization.value;
                        var expectedHeader = 'Basic ${credentials}';
                        
                        if (authHeader !== expectedHeader) {
                            return {
                                statusCode: 401,
                                statusDescription: 'Unauthorized',
                                headers: {
                                    'www-authenticate': { value: 'Basic' }
                                }
                            };
                        }
                        
                        return request;
                    }
                `),
                }
            );
            basicAuthFunctionAssociation = {
                functionAssociations: [
                    {
                        function: basicAuthFunction,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    },
                ],
            };
        }

        /* CLOUDFRONT CDN - CACHING POLICY */
        // Create strict image caching policy
        // RunPods requests disappear after 30 min, so we can't query them from /status
        // endpoint after 30 min. So the CDN cache & bucket TTL determine how long the
        // image persists past 30 min. We can be strict and only allow the image to be
        // accessible for 24-30 hours (24 min, 30 max) via 6 hour cache & 1 day bucket TTL.
        // See S3 bucket section above.
        const imageCachePolicy = new cloudfront.CachePolicy(
            this,
            "ImageCachePolicy",
            {
                comment: "Policy for image content",
                defaultTtl: cdk.Duration.hours(6),
                minTtl: cdk.Duration.hours(6),
                maxTtl: cdk.Duration.hours(6),
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            }
        );

        /* CLOUDFRONT CDN - DISTRIBUTION */
        // Create CloudFront distribution
        const distribution = new cloudfront.Distribution(
            this,
            `WebsiteDistribution`,
            {
                defaultBehavior: {
                    origin: websiteOrigin,
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                    ...(props.stageName === "dev" &&
                        basicAuthFunction &&
                        basicAuthFunctionAssociation),
                    originRequestPolicy:
                        cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    responseHeadersPolicy:
                        cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
                },
                additionalBehaviors: {
                    "/output/*": {
                        origin: outputOrigin,
                        viewerProtocolPolicy:
                            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                        allowedMethods:
                            cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                        compress: true,
                        cachePolicy: imageCachePolicy,
                        originRequestPolicy:
                            cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                        responseHeadersPolicy:
                            cloudfront.ResponseHeadersPolicy
                                .CORS_ALLOW_ALL_ORIGINS,
                        ...(props.stageName === "dev" &&
                            basicAuthFunction &&
                            basicAuthFunctionAssociation),
                    },
                },
                priceClass:
                    props.stageName === "dev"
                        ? cloudfront.PriceClass.PRICE_CLASS_100
                        : cloudfront.PriceClass.PRICE_CLASS_ALL,
                domainNames: [props.domainName],
                certificate: websiteCertificate,
                defaultRootObject: "index.html",
                errorResponses: [
                    {
                        httpStatus: 403,
                        responseHttpStatus: 403,
                        responsePagePath: "/errors/403.html",
                    },
                    {
                        httpStatus: 404,
                        responseHttpStatus: 404,
                        responsePagePath: "/errors/404.html",
                    },
                ],
            }
        );

        /* API GATEWAY - CORS */
        const apiAllowedOrigins = [`https://${props.domainName}`];
        const apiCorsConfig = {
            allowOrigins: apiAllowedOrigins,
            allowMethods: ["GET", "POST"],
            allowHeaders: [
                "Content-Type",
                "Authorization",
                "X-Amz-Date",
                "X-Amz-Security-Token",
                "X-Api-Key",
                "x-amz-content-sha256",
            ],
            allowCredentials: true,
        };

        /* API GATEWAY - DEFINITION */
        const api = new apigateway.RestApi(this, "ImageGenApi", {
            restApiName: `ImageGenerationAPI-${this.account}-${props.stageName}`,
            defaultCorsPreflightOptions: apiCorsConfig,
            defaultMethodOptions: {
                authorizationType: apigateway.AuthorizationType.IAM,
            },
            endpointConfiguration: {
                types: [apigateway.EndpointType.REGIONAL],
            },
        });
        const apiDefinition = new apigateway.Model(this, "ApiDefinition", {
            restApi: api,
            contentType: "application/json",
            modelName: "ApiDefinition",
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                properties: {
                    input: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        properties: {
                            prompt: { type: apigateway.JsonSchemaType.STRING },
                            workflow: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            aspect_ratio: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                        required: ["prompt"],
                    },
                },
            },
        });

        /* API GATEWAY - RUNPODS INTEGRATION */
        const runpodsRunIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/run`,
            {
                httpMethod: "POST",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                    },
                    requestTemplates: {
                        "application/json": `{
                            "input": $input.json('$.input')
                        }`,
                    },
                },
            }
        );
        const runpodsStatusIntegration = new apigateway.HttpIntegration(
            `${props.runpodsEndpoint}/status/{jobId}`,
            {
                httpMethod: "GET",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
                        "integration.request.path.jobId":
                            "method.request.path.jobId",
                    },
                },
            }
        );

        /* API GATEWAY - REQUEST HANDLERS */
        // POST /run endpoint
        const runResource = api.root.addResource("run");
        // Request model for validation
        const runRequestModel = api.addModel("RunRequestModel", {
            contentType: "application/json",
            modelName: `RunRequestModel${this.account}${props.stageName}`,
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ["input"],
                properties: {
                    input: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        required: ["prompt"],
                        properties: {
                            prompt: { type: apigateway.JsonSchemaType.STRING },
                            workflow: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            aspect_ratio: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                    },
                },
            },
        });
        const runMethod = runResource.addMethod("POST", runpodsRunIntegration, {
            requestModels: {
                "application/json": runRequestModel,
            },
            requestValidator: new apigateway.RequestValidator(
                this,
                `RunRequestValidator`,
                {
                    restApi: api,
                    validateRequestBody: true,
                }
            ),
            // methodResponses: [{ statusCode: "200" }],
        });
        // GET /status/{jobId} endpoint
        const statusResource = api.root
            .addResource("status")
            .addResource("{jobId}");
        const statusMethod = statusResource.addMethod(
            "GET",
            runpodsStatusIntegration,
            {
                requestParameters: {
                    "method.request.path.jobId": true,
                },
                // methodResponses: [{ statusCode: "200" }],
            }
        );

        /* API GATEWAY - CUSTOM DOMAINS */
        // Create the custom domain in API Gateway
        const apiCustomDomain = new apigateway.DomainName(
            this,
            "CustomDomainName",
            {
                domainName: props.apiDomainName,
                certificate: apiCertificate,
                endpointType: apigateway.EndpointType.REGIONAL,
                securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
            }
        );
        // Map the custom domain to your API's stage
        new apigateway.BasePathMapping(this, "ApiMapping", {
            restApi: api,
            stage: api.deploymentStage,
            domainName: apiCustomDomain,
        });

        /* API GATEWAY - THROTTLING */
        const apiLimits = calculateTPS(props.throttlingConfig);
        // Create usage plan with throttling settings
        const usagePlan = api.addUsagePlan("ImageGenApiUsagePlan", {
            name: `ImageGenApiUsagePlan-${props.stageName}`,
            throttle: {
                rateLimit: Math.max(
                    apiLimits.limits.runTPS,
                    apiLimits.limits.statusTPS
                ),
                burstLimit: Math.max(
                    apiLimits.limits.runTPSBurst,
                    apiLimits.limits.statusTPSBurst
                ),
            },
        });
        // Add the API stage to the usage plan with method-level throttling
        usagePlan.addApiStage({
            stage: api.deploymentStage,
            throttle: [
                {
                    method: runMethod,
                    throttle: {
                        rateLimit: apiLimits.limits.runTPS,
                        burstLimit: apiLimits.limits.runTPSBurst,
                    },
                },
                {
                    method: statusMethod,
                    throttle: {
                        rateLimit: apiLimits.limits.statusTPS,
                        burstLimit: apiLimits.limits.statusTPSBurst,
                    },
                },
            ],
        });

        /* API GATEWAY - GUEST ACCESS */
        // Secure the API with Cognito
        const identityPool = new cognito.CfnIdentityPool(
            this,
            "ImageGenIdentityPool",
            {
                allowUnauthenticatedIdentities: true,
            }
        );
        // Create IAM role for unauthenticated access
        const unauthRole = new iam.Role(this, "CognitoUnauthRole", {
            assumedBy: new iam.FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                {
                    StringEquals: {
                        "cognito-identity.amazonaws.com:aud": identityPool.ref,
                    },
                    "ForAnyValue:StringLike": {
                        "cognito-identity.amazonaws.com:amr": "unauthenticated",
                    },
                },
                "sts:AssumeRoleWithWebIdentity"
            ),
        });
        // Add execute-api permission to role
        unauthRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["execute-api:Invoke"],
                resources: [
                    `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/*/*/*`,
                ],
            })
        );
        // Set roles on identity pool
        new cognito.CfnIdentityPoolRoleAttachment(
            this,
            "IdentityPoolRoleAttachment",
            {
                identityPoolId: identityPool.ref,
                roles: {
                    unauthenticated: unauthRole.roleArn,
                },
            }
        );

        /* STACK OUTPUTS */
        new cdk.CfnOutput(this, "CertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager in AWS Console for DNS validation records to add to Namecheap. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description: "DNS records needed for SSL certificate validation",
        });
        new cdk.CfnOutput(this, "ApiCertificateValidationRecords", {
            value: "IMPORTANT!! Check Certificate Manager for DNS validation records for images-api-dev.anuv.me to add to Namecheap",
            description:
                "DNS records needed for API SSL certificate validation",
        });
        new cdk.CfnOutput(this, "CloudFrontDomainSetup", {
            value: `DNS Record:\nDomain: ${props.domainName}\nType: CNAME\nTarget: ${distribution.distributionDomainName}`,
            description:
                "CloudFront Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });
        new cdk.CfnOutput(this, "ApiDomainSetup", {
            value: `DNS Record:\nDomain: ${props.apiDomainName}\nType: CNAME\nTarget: ${apiCustomDomain.domainNameAliasDomainName}`,
            description: "API Gateway Domain CNAME record to add in Namecheap",
        });
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: distribution.distributionId,
            description: "CloudFront Distribution ID",
        });
        new cdk.CfnOutput(this, "UploadCredentialsSecretArn", {
            value: uploadCredentialsSecret.secretArn,
            description: "ARN of the secret containing upload credentials",
        });
        new cdk.CfnOutput(this, "ApiUrl", {
            value: api.url,
            description: "URL of the API Gateway endpoint",
        });
        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.ref,
            description:
                "ID of the Cognito Identity Pool for frontend authentication",
        });
        new cdk.CfnOutput(this, "OutputBucketName", {
            value: outputBucket.bucketName,
            description: "Bucket name for storing generated images",
        });
        new cdk.CfnOutput(this, "WebsiteBucketName", {
            value: websiteBucket.bucketName,
            description: "Bucket name for website files",
        });
        new cdk.CfnOutput(this, "MaxConcurrentUsers", {
            value: `${apiLimits.details.metrics.maxSupportedUsers} users / sec`,
            description: `Maximum concurrent users per second supported, calculated from maxWorkers=${apiLimits.inputs.maxWorkers}, generationTimeSeconds=${apiLimits.inputs.generationTimeSeconds}, statusPollIntervalSeconds=${apiLimits.inputs.statusPollIntervalSeconds}, imagesPerSession=${apiLimits.inputs.imagesPerSession}, averageThinkTimeSeconds=${apiLimits.inputs.averageThinkTimeSeconds}`,
        });
    }
}
