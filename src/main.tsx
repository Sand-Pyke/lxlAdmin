import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Application from './App';
import { ApiError } from './api/client';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failureCount, error) =>
        failureCount < 1 &&
        (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    },
    mutations: { retry: false },
  },
});
const router = createBrowserRouter([{ path: '*', element: <Application /> }]);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#37654c',
          colorInfo: '#37654c',
          colorSuccess: '#438660',
          colorText: '#24332e',
          colorTextSecondary: '#738079',
          colorBgLayout: '#f5f7f5',
          colorBorderSecondary: '#eaf0e9',
          borderRadius: 8,
          fontSize: 14,
          controlHeight: 38,
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: { headerBg: '#f8faf7', headerColor: '#6c7970', cellPaddingBlock: 17 },
          Card: { headerFontSize: 16 },
          Menu: {
            itemSelectedBg: '#c5e59b',
            itemSelectedColor: '#172b28',
            itemColor: '#b6c6bc',
            itemHoverColor: '#ffffff',
            itemHoverBg: '#263d35',
            itemBg: 'transparent',
            itemHeight: 46,
          },
        },
      }}
    >
      <App>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </App>
    </ConfigProvider>
  </React.StrictMode>,
);
