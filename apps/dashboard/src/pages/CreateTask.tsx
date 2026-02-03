import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { tasksApi } from '../lib/api';
import { ChevronLeft, Save, Plus, X } from 'lucide-react';
import type { CreateTaskInput } from '@sebastian-code/core';

export const CreateTaskPage: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    title: '',
    goal: '',
    priority: 10,
    riskLevel: 'low' as 'low' | 'medium' | 'high',
    role: 'worker' as 'worker' | 'tester',
    timeboxMinutes: 60,
    allowedPaths: [''],
    commands: [''],
    context: {
      specs: '',
      files: [''],
    },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateTaskInput) => tasksApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      navigate('/tasks');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // クリーンアップ: 空の文字列を除去
    const cleanedData: CreateTaskInput = {
      title: formData.title,
      goal: formData.goal,
      priority: formData.priority,
      riskLevel: formData.riskLevel,
      role: formData.role,
      timeboxMinutes: formData.timeboxMinutes,
      allowedPaths: formData.allowedPaths.filter(p => p.trim() !== ''),
      commands: formData.commands.filter(c => c.trim() !== ''),
      touches: [], // 初期値は空配列
      context: {
        specs: formData.context.specs || undefined,
        files: formData.context.files.filter(f => f.trim() !== ''),
      },
    };

    mutation.mutate(cleanedData);
  };

  const handleArrayChange = (
    field: 'allowedPaths' | 'commands' | 'files',
    index: number,
    value: string
  ) => {
    if (field === 'files') {
      const newFiles = [...formData.context.files];
      newFiles[index] = value;
      setFormData({ ...formData, context: { ...formData.context, files: newFiles } });
    } else {
      const newArr = [...formData[field]];
      newArr[index] = value;
      setFormData({ ...formData, [field]: newArr });
    }
  };

  const addArrayItem = (field: 'allowedPaths' | 'commands' | 'files') => {
    if (field === 'files') {
      setFormData({ 
        ...formData, 
        context: { ...formData.context, files: [...formData.context.files, ''] } 
      });
    } else {
      setFormData({ ...formData, [field]: [...formData[field], ''] });
    }
  };

  const removeArrayItem = (field: 'allowedPaths' | 'commands' | 'files', index: number) => {
    if (field === 'files') {
      const newFiles = formData.context.files.filter((_, i) => i !== index);
      setFormData({ ...formData, context: { ...formData.context, files: newFiles } });
    } else {
      const newArr = formData[field].filter((_, i) => i !== index);
      setFormData({ ...formData, [field]: newArr });
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <Link to="/tasks" className="flex items-center gap-2 text-slate-400 hover:text-white mb-6 transition-colors">
        <ChevronLeft size={20} />
        Back to Tasks
      </Link>

      <h1 className="text-3xl font-bold mb-8">Create New Task</h1>

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Task Title</label>
              <input
                type="text"
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                placeholder="e.g. Add validation to user service"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Goal & Acceptance Criteria</label>
              <textarea
                required
                rows={4}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                placeholder="Describe what needs to be achieved and how to verify it..."
                value={formData.goal}
                onChange={e => setFormData({ ...formData, goal: e.target.value })}
              />
            </div>
          </div>

          {/* Configuration */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Priority</label>
              <input
                type="number"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                value={formData.priority}
                onChange={e => setFormData({ ...formData, priority: parseInt(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Risk Level</label>
              <select
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                value={formData.riskLevel}
                onChange={e => setFormData({ ...formData, riskLevel: e.target.value as 'low' | 'medium' | 'high' })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Role</label>
              <select
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                value={formData.role}
                onChange={e => setFormData({ ...formData, role: e.target.value as 'worker' | 'tester' })}
              >
                <option value="worker">Worker</option>
                <option value="tester">Tester</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Timebox (min)</label>
              <input
                type="number"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 transition-all"
                value={formData.timeboxMinutes}
                onChange={e => setFormData({ ...formData, timeboxMinutes: parseInt(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Allowed Paths & Commands */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <div className="flex justify-between items-center mb-4">
              <label className="text-sm font-bold text-slate-500 uppercase tracking-wider">Allowed Paths</label>
              <button type="button" onClick={() => addArrayItem('allowedPaths')} className="text-yellow-500 hover:text-yellow-400">
                <Plus size={18} />
              </button>
            </div>
            <div className="space-y-2">
              {formData.allowedPaths.map((path, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs font-mono text-slate-300"
                    placeholder="src/**/*.ts"
                    value={path}
                    onChange={e => handleArrayChange('allowedPaths', i, e.target.value)}
                  />
                  {formData.allowedPaths.length > 1 && (
                    <button type="button" onClick={() => removeArrayItem('allowedPaths', i)} className="text-slate-600 hover:text-red-400">
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <div className="flex justify-between items-center mb-4">
              <label className="text-sm font-bold text-slate-500 uppercase tracking-wider">Verification Commands</label>
              <button type="button" onClick={() => addArrayItem('commands')} className="text-yellow-500 hover:text-yellow-400">
                <Plus size={18} />
              </button>
            </div>
            <div className="space-y-2">
              {formData.commands.map((cmd, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs font-mono text-yellow-500"
                    placeholder="pnpm test"
                    value={cmd}
                    onChange={e => handleArrayChange('commands', i, e.target.value)}
                  />
                  {formData.commands.length > 1 && (
                    <button type="button" onClick={() => removeArrayItem('commands', i)} className="text-slate-600 hover:text-red-400">
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-4">
          <button
            type="button"
            onClick={() => navigate('/tasks')}
            className="px-6 py-2 rounded-lg font-medium text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 px-8 py-2 rounded-lg font-bold flex items-center gap-2 transition-all"
          >
            <Save size={20} />
            {mutation.isPending ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </form>
    </div>
  );
};
