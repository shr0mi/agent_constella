// Local CLI fixture for capture-readme.cjs. Only the disposable app's MCP server is used.
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

async function main() {
  const urlSetting = 'mcp_servers.agent_constella.url='
  const url = new URL(JSON.parse(process.argv.find((arg) => arg.startsWith(urlSetting)).slice(urlSetting.length)))
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(process.env.CONSTELLA_MCP_TOKEN)
  const client = new Client({ name: 'constella-readme-demo', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${process.env.CONSTELLA_MCP_TOKEN}` } },
  }))

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return JSON.parse(result.content[0].text)
  }

  try {
    const prompt = process.argv.at(-1).split('\nUser request:\n').at(-1)
    console.log('\x1b[1mCodex CLI · Documentation demo\x1b[0m\n')
    console.log(`\x1b[1m› ${prompt}\x1b[0m\n`)
    console.log('• I’ll check the project context and add a task to the board.\n')
    const context = await call('workspace_get_context', {})
    console.log('\x1b[32m• Called\x1b[0m agent_constella.workspace_get_context')
    console.log(`  Project: ${context.project.name}\n`)

    const { task } = await call('todo_create', {
      commandId: randomUUID(),
      title: 'Save and display the last three stopwatch sessions',
      description: 'Store completed sessions locally and show the three most recent durations under the timer.',
      acceptanceCriteria: 'The latest three completed sessions survive a reload and appear newest first.',
    })
    assert.equal(task.status, 'todo')
    console.log('\x1b[32m• Called\x1b[0m agent_constella.todo_create\n')
    console.log(`\x1b[1mCreated in To Do\x1b[0m · ${task.title}`)
    console.log('  Store completed sessions locally and show the three latest durations.')
    console.log('  The task is recorded in Changes & Undo.\n')
    process.stdout.write('\x1b[2m› Ask Codex about this project\x1b[0m ')
    process.stdin.resume()
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
