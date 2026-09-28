<template>
  <button @click="increment">{{ total }}</button>
</template>

<script setup lang="ts">
import { ref } from "vue";

const total = ref<number>(0);

function increment(): void {
  total.value += 1;
}
</script>
