import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { OverviewPage } from './pages/Overview'
import { TasksPage } from './pages/Tasks'
import { TaskDetailsPage } from './pages/TaskDetails'
import { CreateTaskPage } from './pages/CreateTask'
import { RunsPage } from './pages/Runs'
import { RunDetailsPage } from './pages/RunDetails'
import { AgentsPage } from './pages/Agents'
import { PlansPage } from './pages/Plans'
import { JudgementsPage } from './pages/Judgements'
import { AgentDetailsPage } from './pages/AgentDetails'

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/new" element={<CreateTaskPage />} />
          <Route path="/tasks/:id" element={<TaskDetailsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentDetailsPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/judgements" element={<JudgementsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}

export default App
