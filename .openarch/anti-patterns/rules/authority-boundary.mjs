export default {
  scope: "change_set",
  requires: ["authorities.v1"],
  staticImports: true,
  detect: ({ changeSet, facts }) => {
    const hits = [];
    for (const authority of facts.authorities.value ?? []) {
      const prohibitedImports = new Set(authority.prohibitedImports ?? []);
      if (prohibitedImports.size === 0) continue;
      for (const file of changeSet.files) {
        if (!file.afterText || !file.authorityIds?.includes(authority.id)) continue;
        const before = new Set(file.beforeStaticImports ?? []);
        for (const source of file.afterStaticImports ?? []) {
          if (!prohibitedImports.has(source) || before.has(source)) continue;
          hits.push({
            ruleId: "authority-boundary-bypass",
            file: file.path,
            message: `new direct import ${source} crosses declared authority ${authority.id}; use ${authority.publicEntry ?? authority.owner}`,
            evidence: `authority=${authority.id}; owner=${authority.owner}; addedImport=${source}`,
          });
        }
      }
    }
    return hits;
  },
};
