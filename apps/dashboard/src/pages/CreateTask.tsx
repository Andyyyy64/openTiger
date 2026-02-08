import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { tasksApi } from '../lib/api';
import type { CreateTaskInput } from '@openTiger/core';

export const CreateTaskPage: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    title: '',
    goal: '',
    priority: 10,
    riskLevel: 'low' as 'low' | 'medium' | 'high',
    role: 'worker' as 'worker' | 'tester' | 'docser',
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

    const cleanedData: CreateTaskInput = {
      title: formData.title,
      goal: formData.goal,
      priority: formData.priority,
      riskLevel: formData.riskLevel,
      role: formData.role,
      timeboxMinutes: formData.timeboxMinutes,
      allowedPaths: formData.allowedPaths.filter(p => p.trim() !== ''),
      commands: formData.commands.filter(c => c.trim() !== ''),
      touches: [],
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
    <div className="p-6 max-w-4xl mx-auto text-term-fg">
      <Link to="/tasks" className="inline-block text-xs font-mono text-zinc-500 hover:text-term-tiger mb-6 group">
        &lt; cd ..
      </Link>

      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Task_Initialization_Wizard
        </h1>
        <div className="text-xs text-zinc-500 font-mono">
          [MODE: CREATE]
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="border border-term-border p-0">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
            <h2 className="text-sm font-bold uppercase tracking-wider">01_Primary_Directive</h2>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wide mb-1">Task_Identifier (Title)</label>
              <input
                type="text"
                required
                className="w-full bg-black border border-term-border px-3 py-2 text-sm text-term-fg font-mono focus:border-term-tiger focus:outline-none"
                placeholder="e.g. Implement user authentication logic"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wide mb-1">Execution_Goal & Acceptance_Criteria</label>
              <textarea
                required
                rows={6}
                className="w-full bg-black border border-term-border px-3 py-2 text-sm text-term-fg font-mono focus:border-term-tiger focus:outline-none"
                placeholder="Define the objective and success conditions..."
                value={formData.goal}
                onChange={e => setFormData({ ...formData, goal: e.target.value })}
              />
            </div>
          </div>
        </section>

        <section className="border border-term-border p-0">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
            <h2 className="text-sm font-bold uppercase tracking-wider">02_Configuration_Parameters</h2>
          </div>
          <div className="p-6 grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="space-y-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase">Priority_Level</label>
              <input
                type="number"
                className="w-full bg-black border border-b border-term-border px-2 py-1 text-sm font-mono focus:border-term-tiger focus:outline-none"
                value={formData.priority}
                onChange={e => setFormData({ ...formData, priority: parseInt(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase">Risk_Assessment</label>
              <select
                className="w-full bg-black border border-b border-term-border px-2 py-1 text-sm font-mono focus:border-term-tiger focus:outline-none"
                value={formData.riskLevel}
                onChange={e => setFormData({ ...formData, riskLevel: e.target.value as 'low' | 'medium' | 'high' })}
              >
                <option value="low">LOW</option>
                <option value="medium">MEDIUM</option>
                <option value="high">HIGH</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase">Assigned_Role</label>
              <select
                className="w-full bg-black border border-b border-term-border px-2 py-1 text-sm font-mono focus:border-term-tiger focus:outline-none"
                value={formData.role}
                onChange={e => setFormData({ ...formData, role: e.target.value as 'worker' | 'tester' | 'docser' })}
              >
                <option value="worker">WORKER</option>
                <option value="tester">TESTER</option>
                <option value="docser">DOCSER</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase">Timebox (Min)</label>
              <input
                type="number"
                className="w-full bg-black border border-b border-term-border px-2 py-1 text-sm font-mono focus:border-term-tiger focus:outline-none"
                value={formData.timeboxMinutes}
                onChange={e => setFormData({ ...formData, timeboxMinutes: parseInt(e.target.value) })}
              />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border border-term-border">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between items-center">
              <label className="text-sm font-bold text-zinc-500 uppercase tracking-wider">Scope: Allowed_Paths</label>
              <button type="button" onClick={() => addArrayItem('allowedPaths')} className="text-term-tiger text-xs hover:underline">[ ADD ]</button>
            </div>
            <div className="p-4 space-y-2">
              {formData.allowedPaths.map((path, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 bg-black border border-term-border px-2 py-1 text-xs font-mono text-zinc-300 focus:border-term-tiger focus:outline-none"
                    placeholder="src/**/*.ts"
                    value={path}
                    onChange={e => handleArrayChange('allowedPaths', i, e.target.value)}
                  />
                  {formData.allowedPaths.length > 1 && (
                    <button type="button" onClick={() => removeArrayItem('allowedPaths', i)} className="text-red-500 text-xs px-2 hover:bg-red-900/20">X</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border border-term-border">
            <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between items-center">
              <label className="text-sm font-bold text-zinc-500 uppercase tracking-wider">Verification: Commands</label>
              <button type="button" onClick={() => addArrayItem('commands')} className="text-term-tiger text-xs hover:underline">[ ADD ]</button>
            </div>
            <div className="p-4 space-y-2">
              {formData.commands.map((cmd, i) => (
                <div key={i} className="flex gap-2">
                  <div className="flex items-center text-zinc-600 select-none">$</div>
                  <input
                    type="text"
                    className="flex-1 bg-black border border-term-border px-2 py-1 text-xs font-mono text-yellow-500 focus:border-term-tiger focus:outline-none"
                    placeholder="npm test"
                    value={cmd}
                    onChange={e => handleArrayChange('commands', i, e.target.value)}
                  />
                  {formData.commands.length > 1 && (
                    <button type="button" onClick={() => removeArrayItem('commands', i)} className="text-red-500 text-xs px-2 hover:bg-red-900/20">X</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="flex justify-end gap-6 pt-6 border-t border-term-border">
          <button
            type="button"
            onClick={() => navigate('/tasks')}
            className="text-zinc-500 hover:text-red-500 text-sm font-mono uppercase transition-colors"
          >
            [ CANCEL ]
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="text-term-tiger border border-term-tiger hover:bg-term-tiger hover:text-black px-6 py-2 text-sm font-bold font-mono uppercase transition-all disabled:opacity-50"
          >
            {mutation.isPending ? '> INITIATING...' : '> EXECUTE_CREATE'}
          </button>
        </div>
      </form>
    </div>
  );
};
