import { Layout } from './components/Layout'

function App() {
  return (
    <Layout>
      <div className="p-6">
        <h1 className="text-3xl font-bold mb-6">Dashboard Overview</h1>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
            <h2 className="text-slate-400 text-sm font-medium mb-1">Active Workers</h2>
            <p className="text-4xl font-bold">12</p>
          </div>
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
            <h2 className="text-slate-400 text-sm font-medium mb-1">Pending Tasks</h2>
            <p className="text-4xl font-bold">45</p>
          </div>
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
            <h2 className="text-slate-400 text-sm font-medium mb-1">Completed (24h)</h2>
            <p className="text-4xl font-bold text-green-400">128</p>
          </div>
        </div>
      </div>
    </Layout>
  )
}

export default App
