<template>
  <p>{{ count }}</p>
</template>

<script>
import { audit } from "./audit";

export default {
  name: "AuditPanel",
  methods: {
    run(threshold) {
      if (threshold > 0) {
        return audit(this.name, threshold);
      }
      return audit(this.name);
    },
  },
};
</script>
