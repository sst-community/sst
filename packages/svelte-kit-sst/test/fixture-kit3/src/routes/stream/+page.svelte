<script lang="ts">
	let { data } = $props();
</script>

<p id="now">{data.now}</p>
{#await data.later}<p id="later">waiting</p>{:then later}<p id="later">{later}</p>{/await}
