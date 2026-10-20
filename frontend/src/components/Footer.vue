<template>
  <footer>
    <div class="copyright">
      <n-text class="description" v-html="packageJson.description" />
    </div>
  </footer>
</template>

<script setup>
import packageJson from "@/../package.json";
</script>

<style lang="scss" scoped>
footer {
  height: 100px;
  padding: 0 5vw;
  max-width: 1800px;
  margin: 20px auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  .copyright {
    margin-bottom: 4px;
  }
}
</style>
