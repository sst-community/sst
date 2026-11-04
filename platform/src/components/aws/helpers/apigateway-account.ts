import { getPartitionOutput, apigateway, iam } from "@pulumi/aws";
import {
  ComponentResourceOptions,
  ProviderResource,
  jsonStringify,
  interpolate,
} from "@pulumi/pulumi";
import { knownValue } from "../../args";
import { perRun } from "../../../util/lazy";

// The account is a singleton per provider, so gateways on the same provider
// share one read. The read uses the first gateway's
// `<Name>APIGatewayAccount` name.
const useAccountReads = perRun(
  () => new Map<ProviderResource | undefined, apigateway.Account>(),
);

function useAccountRead(namePrefix: string, opts: ComponentResourceOptions) {
  const reads = useAccountReads();
  const existing = reads.get(opts.provider);
  if (existing) return existing;

  const account = apigateway.Account.get(
    `${namePrefix}APIGatewayAccount`,
    "APIGatewayAccount",
    undefined,
    { provider: opts.provider },
  );
  reads.set(opts.provider, account);
  return account;
}

// Made once in each run of the program, like the account's read
const cloudWatchRoles = perRun(() => ({
  role: undefined as iam.Role | undefined,
}));

function useCloudWatchRole(opts: ComponentResourceOptions) {
  const partition = getPartitionOutput(undefined, opts).partition;
  const made = cloudWatchRoles();
  made.role ??= new iam.Role(
    `APIGatewayPushToCloudWatchLogsRole`,
    {
      assumeRolePolicy: jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "apigateway.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      managedPolicyArns: [
        interpolate`arn:${partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs`,
      ],
    },
    { retainOnDelete: true, provider: opts.provider },
  );
  return made.role;
}

/**
 * API Gateway's account settings, which a REST or WebSocket API needs to write its access
 * logs: read with the API's provider, and given a role to write logs with when the
 * account has none. Neither is a part: the account is one for each region, and the
 * setup is kept when the API is removed. Whether there's a setup is decided once the
 * read is known, which a preview reads too, so `sst diff` shows it.
 *
 * Returns what the API waits for: the setup when there is one, and the read when not.
 *
 * ```ts
 * const account = apiGatewayAccount(this.builder(), name);
 * this.part("api", { ... }, { dependsOn: account });
 * ```
 */
export function apiGatewayAccount(
  builder: {
    component: {
      getProvider(moduleMember: string): ProviderResource | undefined;
    };
    after<T, R>(
      ready: Promise<T>,
      create: (value: T) => R | Promise<R>,
    ): Promise<R>;
  },
  namePrefix: string,
): Promise<apigateway.Account> {
  const opts = { provider: builder.component.getProvider("aws::") };
  const account = useAccountRead(namePrefix, opts);
  return builder.after(
    // Empty when the account has no role, and undefined while a preview
    // doesn't know, when nothing is set up
    knownValue(account.cloudwatchRoleArn.apply((arn) => arn ?? "")),
    (arn) =>
      arn !== ""
        ? account
        : new apigateway.Account(
            `${namePrefix}APIGatewayAccountSetup`,
            { cloudwatchRoleArn: useCloudWatchRole(opts).arn },
            { retainOnDelete: true, provider: opts.provider },
          ),
  );
}

// SST 4's: the 4.x `ApiGatewayV1` and `ApiGatewayWebSocket` set the account up
// inside an `apply`, with the provider given to the API itself
export function setupApiGatewayAccount(
  namePrefix: string,
  opts: ComponentResourceOptions,
) {
  const account = useAccountRead(namePrefix, opts);

  return account.cloudwatchRoleArn.apply((arn) => {
    if (arn) return account;

    return new apigateway.Account(
      `${namePrefix}APIGatewayAccountSetup`,
      {
        cloudwatchRoleArn: useCloudWatchRole(opts).arn,
      },
      { retainOnDelete: true, provider: opts.provider },
    );
  });
}
