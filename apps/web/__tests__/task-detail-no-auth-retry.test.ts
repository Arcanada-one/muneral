import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import apiClient from '@/lib/api/client';
import type { AxiosRequestConfig } from 'axios';
import { getSession, signOut } from 'next-auth/react';

vi.mock('next-auth/react',()=>({getSession:vi.fn(async()=>({accessToken:'synthetic',refreshToken:'synthetic-refresh'})),signOut:vi.fn()}));
describe('I05 read opts out of legacy refresh side effects',()=>{
  it('actual Axios interceptor returns 401 after one attempt without refresh or sign-out',async()=>{
    let attempts=0;
    const refresh=vi.spyOn(axios,'post').mockRejectedValue(new Error('Synthetic refresh blocked'));
    const config:AxiosRequestConfig & {skipAuthRefresh:boolean}={skipAuthRefresh:true,adapter:async config=>{
      attempts++;
      throw new AxiosError('synthetic denial','ERR_BAD_REQUEST',config,undefined,{status:401,data:{},statusText:'Unauthorized',headers:{},config});
    }};
    await expect(apiClient.get('/synthetic-only',config)).rejects.toMatchObject({response:{status:401}});
    expect(attempts).toBe(1);expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1); // Request auth only; no refresh auth lookup.
  });
});
