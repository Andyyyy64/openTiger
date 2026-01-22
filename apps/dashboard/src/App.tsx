import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { OverviewPage } from './pages/Overview'
import { TasksPage } from './pages/Tasks'
import { RunsPage } from './pages/Runs'
import { AgentsPage } from './pages/Agents'

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}

export default App
