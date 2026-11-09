import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { previewAuthAdmission } from './preview-admission.js';

const response = () => Object.assign(new EventEmitter(), { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
describe('preview native-memory admission', () => {
  it('rejects overlapping auth writes and releases the slot exactly once', () => {
    const middleware = previewAuthAdmission(), next = vi.fn();
    const req = { method: 'POST', path: '/api/auth/login' } as Request;
    const first = response(), second = response(), third = response(), fourth = response();
    middleware(req, first as unknown as Response, next);
    middleware(req, second as unknown as Response, next);
    expect(second.status).toHaveBeenCalledWith(429); expect(next).toHaveBeenCalledTimes(1);
    first.emit('finish'); middleware(req, third as unknown as Response, next);
    first.emit('close'); middleware(req, fourth as unknown as Response, next);
    expect(fourth.status).toHaveBeenCalledWith(429); expect(next).toHaveBeenCalledTimes(2);
  });
  it('keeps public reads and unrelated writes available', () => {
    const middleware = previewAuthAdmission(), next = vi.fn();
    middleware({ method: 'POST', path: '/api/auth/login' } as Request, response() as unknown as Response, next);
    middleware({ method: 'GET', path: '/api/auth/me' } as Request, response() as unknown as Response, next);
    middleware({ method: 'POST', path: '/api/organizations' } as Request, response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
