import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import ProvisioningPage from './page';
it('offers product registration, tenant onboarding and a UUID-based hospital resume',()=>{
 render(<ProvisioningPage/>);
 expect(screen.getByRole('link',{name:/Product onboarding/})).toHaveAttribute('href','/platform/provisioning/products');
 expect(screen.getByRole('link',{name:/Tenant onboarding/})).toHaveAttribute('href','/platform/provisioning/orgs');
 const input=screen.getByLabelText('Tenant UUID');
 expect(input).toHaveAttribute('name','tenantId');
 expect(input.closest('form')).toHaveAttribute('action','/platform/provisioning/orgs/hospital');
 expect(screen.getByRole('button',{name:'Resume hospital onboarding'})).toHaveAttribute('type','submit');
});
