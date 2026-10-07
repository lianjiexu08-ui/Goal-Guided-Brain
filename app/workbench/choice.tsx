'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ChoiceProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
};

export function Choice({ label, value, onChange, options }: ChoiceProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => next !== null && onChange(next)}
    >
      <SelectTrigger aria-label={label} className="choice">
        <SelectValue>
          {options.find((option) => option.value === value)?.label || '请选择'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
