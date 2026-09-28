<template>
  <div class="counter">{{ count }}</div>
</template>

<script>
import { createCounter } from "./create-counter";

export default {
  name: "BasicCounter",
  data() {
    return { count: 0 };
  },
  methods: {
    increment() {
      if (this.count >= 10) {
        this.count = 0;
      } else {
        this.count += 1;
      }
    },
  },
};
</script>
