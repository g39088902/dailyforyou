import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { queryRows } from "../db/client.js";
import { SOURCE_REGISTRY } from "../data/sourceRegistry.js";
import { getAllAvailableRoutes } from "../runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGOS_DIR = path.resolve(__dirname, "../../assets/logos");

export const runDoctor = async (): Promise<void> => {
  console.log(chalk.bold.cyan("\n🩺 [Crawler Doctor] 启动信源四方对账与健康诊断...\n"));

  // 1. 收集四方数据
  const registryList = SOURCE_REGISTRY;
  const registryKeys = new Set(registryList.map((s) => s.key));
  const registryAdapters = new Set(registryList.map((s) => s.adapter));

  const availableAdapters = getAllAvailableRoutes();
  const adapterSet = new Set(availableAdapters);

  // 数据库 sources 与 news_items
  const dbSources = await queryRows("SELECT key, name, sub_type, enabled, retired, status, items_total, has_logo FROM sources");
  const dbSourceKeys = new Set(dbSources.map((r: any) => String(r.key)));

  const dbNewsSummary = await queryRows(
    "SELECT source_name, sub_type, count(*) as count FROM news_items GROUP BY source_name, sub_type ORDER BY count DESC",
  );

  // 本地图标文件与库中图标
  const localLogoFiles = fs.existsSync(LOGOS_DIR)
    ? fs.readdirSync(LOGOS_DIR).filter((f) => !f.startsWith("."))
    : [];
  const localLogoKeys = new Set(
    localLogoFiles.map((f) => path.basename(f, path.extname(f))),
  );

  const dbLogoRows = await queryRows("SELECT key FROM source_logos");
  const dbLogoKeys = new Set(dbLogoRows.map((r: any) => String(r.key)));

  // 2. 核心指标统计
  console.log(
    chalk.bold(
      `📊 概览：注册表 ${chalk.green(registryList.length)} 条 / 适配器 ${chalk.green(
        availableAdapters.length,
      )} 个 / 库中历史数据 ${chalk.green(dbNewsSummary.length)} 组 / 本地图标 ${chalk.green(
        localLogoFiles.length,
      )} 张 (入库 ${chalk.green(dbLogoKeys.size)} 张)\n`,
    ),
  );

  // 3. 四方交叉漂移检查
  // A. 注册表有、适配器缺失
  const missingAdapters = registryList.filter((s) => !adapterSet.has(s.adapter));
  if (missingAdapters.length > 0) {
    console.log(
      chalk.red(
        `✗ 注册表已收录但适配器缺失 (${missingAdapters.length}): ${missingAdapters
          .map((s) => `${s.key} (adapter: ${s.adapter})`)
          .join(", ")}`,
      ),
    );
  } else {
    console.log(chalk.green(`✓ 所有注册表信源适配器均完备`));
  }

  // B. 适配器存在、注册表未收录
  const unmappedAdapters = availableAdapters.filter((a) => !registryAdapters.has(a));
  if (unmappedAdapters.length > 0) {
    console.log(
      chalk.yellow(
        `✗ 适配器存在但注册表未收录 (${unmappedAdapters.length}): ${unmappedAdapters.join(
          ", ",
        )}`,
      ),
    );
  } else {
    console.log(chalk.green(`✓ 无未收录的游离适配器`));
  }

  // C. 库中有数据、注册表中无对应信源
  const unmappedDbGroups: Array<{ name: string; subType: string; count: number }> = [];
  for (const row of dbNewsSummary) {
    const sName = String(row.source_name || "");
    const subType = String(row.sub_type || "");
    const count = Number(row.count || 0);
    if (!sName) continue;

    const matched = registryList.some(
      (s) => s.name === sName && (s.subType || "") === subType,
    );
    if (!matched) {
      unmappedDbGroups.push({ name: sName, subType, count });
    }
  }

  if (unmappedDbGroups.length > 0) {
    console.log(
      chalk.yellow(
        `✗ 库中有数据但注册表未收录 (${unmappedDbGroups.length}): ${unmappedDbGroups
          .map((g) => `${g.name}${g.subType ? `/${g.subType}` : ""} (${g.count}条)`)
          .join(", ")}`,
      ),
    );
  } else {
    console.log(chalk.green(`✓ 库中历史数据均能匹配到注册表信源`));
  }

  // D. 有图标、注册表中无
  const orphanedLogos = [...localLogoKeys].filter((k) => !registryKeys.has(k));
  if (orphanedLogos.length > 0) {
    console.log(
      chalk.yellow(
        `✗ 存在本地图标但注册表无此 key (${orphanedLogos.length}): ${orphanedLogos.join(", ")}`,
      ),
    );
  } else {
    console.log(chalk.green(`✓ 本地图标均与注册表 key 吻合`));
  }

  // 4. 注册表信源的图标覆盖度
  const sourcesWithoutLogo = registryList.filter(
    (s) => !localLogoKeys.has(s.key) && !dbLogoKeys.has(s.key),
  );
  if (sourcesWithoutLogo.length > 0) {
    console.log(
      chalk.cyan(
        `ℹ 无图标图片（自动使用文字徽标兜底）(${sourcesWithoutLogo.length}): ${sourcesWithoutLogo
          .map((s) => s.key)
          .join(", ")}`,
      ),
    );
  }

  // 5. 数据库 sources 表状态快照
  const statusCounts: Record<string, number> = {
    ok: 0,
    empty: 0,
    failed: 0,
    idle: 0,
    running: 0,
  };
  let disabledCount = 0;
  let retiredCount = 0;

  for (const s of dbSources) {
    const st = String(s.status || "idle");
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (s.enabled === 0) disabledCount++;
    if (s.retired === 1) retiredCount++;
  }

  console.log(chalk.bold("\n📈 数据库 sources 运行状态："));
  console.log(
    `  • ok: ${chalk.green(statusCounts.ok || 0)} | empty: ${chalk.yellow(
      statusCounts.empty || 0,
    )} | failed: ${chalk.red(statusCounts.failed || 0)} | idle: ${chalk.blue(
      statusCounts.idle || 0,
    )} | running: ${chalk.magenta(statusCounts.running || 0)}`,
  );
  console.log(
    `  • 人工禁用 (enabled=0): ${disabledCount} | 已下线 (retired=1): ${retiredCount}\n`,
  );
};
