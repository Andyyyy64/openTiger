import React from 'react';

export const OverviewPage: React.FC = () => {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">System Overview</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatCard title="Active Workers" value="12" subValue="Across 3 regions" />
        <StatCard title="Pending Tasks" value="45" subValue="12 high priority" />
        <StatCard title="Success Rate" value="94.2%" subValue="+2.1% from last cycle" color="text-green-400" />
      </div>
      
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-4">Recent Activity</h2>
        <div className="text-slate-400 text-center py-12">
          Activity feed coming soon...
        </div>
      </div>
    </div>
  );
};

const StatCard = ({ title, value, subValue, color = "text-white" }: { title: string, value: string, subValue: string, color?: string }) => (
  <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-sm">
    <h3 className="text-slate-400 text-sm font-medium mb-1">{title}</h3>
    <p className={`text-4xl font-bold mb-2 ${color}`}>{value}</p>
    <p className="text-slate-500 text-xs">{subValue}</p>
  </div>
);
