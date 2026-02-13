import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/Overview";
import { TasksPage } from "./pages/Tasks";
import { TaskDetailsPage } from "./pages/TaskDetails";
import { RunsPage } from "./pages/Runs";
import { RunDetailsPage } from "./pages/RunDetails";
import { AgentsPage } from "./pages/Agents";
import { PlansPage } from "./pages/Plans";
import { JudgementsPage } from "./pages/Judgements";
import { AgentDetailsPage } from "./pages/AgentDetails";
import { SettingsPage } from "./pages/Settings";
import { StartPage } from "./pages/Start";
import { LogsPage } from "./pages/Logs";
import { ResearchPage } from "./pages/Research";
import { ResearchJobDetailsPage } from "./pages/ResearchJobDetails";

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/start" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentDetailsPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/judgements" element={<JudgementsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/research/:id" element={<ResearchJobDetailsPage />} />
          <Route path="/start" element={<StartPage />} />
          <Route path="/requirement" element={<StartPage />} />
          <Route path="/system" element={<SettingsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/start" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
