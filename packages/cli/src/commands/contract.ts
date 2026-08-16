import { CONTRACT_CATALOG_SCHEMA, machineContractDescriptors } from "@openarch/core";
import { message } from "../i18n";
import { type CommandHandler } from "../runtime";
import { OPENARCH_VERSION } from "../version";

/**
 * 机器契约目录：外部插件启动时读取，感知每个可消费 JSON 契约的当前版本。
 * 读取失败/版本未知时插件应 fail-closed（降级为文本报告或不消费该契约），
 * 不允许把未知版本当旧版本静默解析。
 */
export const contractCommand: CommandHandler = async (args, context) => {
  if (args.some((arg) => arg !== "--json")) {
    console.error(message(context.locale, "contract.usage"));
    return 3;
  }
  const contracts = machineContractDescriptors();
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      schema: CONTRACT_CATALOG_SCHEMA,
      openarchVersion: OPENARCH_VERSION,
      contracts,
    }, null, 2));
    return 0;
  }
  console.log(message(context.locale, "contract.heading"));
  for (const descriptor of contracts) {
    console.log(message(context.locale, "contract.entry", {
      id: descriptor.id,
      version: descriptor.version,
      status: descriptor.status,
    }));
  }
  console.log(message(context.locale, "contract.policy"));
  return 0;
};
