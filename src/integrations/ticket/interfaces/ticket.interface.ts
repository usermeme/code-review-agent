export interface Ticket {
    id: string;
    url: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    subtasks: { title: string; done: boolean }[];
    status: string;
}
