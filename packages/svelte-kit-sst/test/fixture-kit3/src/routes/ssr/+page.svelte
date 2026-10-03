<script lang="ts">
	let { data, form } = $props();
</script>

<h1 id="hello">Hello {data.name}</h1>
<p id="visits">visits: {data.visits}</p>
{#if form?.saved}<p id="saved">saved: {form.saved}</p>{/if}
{#if form?.error}<p id="error">error: {form.error}</p>{/if}

<form method="POST">
	<input name="name" />
	<button>save</button>
</form>
